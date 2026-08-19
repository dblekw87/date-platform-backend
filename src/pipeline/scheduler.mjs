import { fetchShortInterest, loadStoredSettlements, saveShortInterest, settlementCandidates } from "../providers/short-interest.mjs";
import { loadShortVolume, saveShortVolume, storedShortVolumeDates } from "../providers/short-volume.mjs";
import { fillUsIntraday, loadRecentTargets } from "./us-intraday.mjs";
import { isUniverseStale, newestUniverseDate, refreshUsUniverse, universeSnapshotDate } from "./us-reference.mjs";
import { sessionDate } from "../providers/market-session.mjs";
import { hasUsPipelineTables, isUsPipelineDue, runUsDailyPipeline } from "./us-daily-run.mjs";

/**
 * Keeps the US surge data current without anyone remembering to.
 *
 * Not a cron. This runs on one desktop that is meant to stay on but will not
 * always have, so a fixed 07:00 firing is missed on exactly the mornings it
 * matters. Instead the check is "is yesterday's session in the database", asked
 * once at startup and every hour after — which means the machine coming back at
 * any hour brings the board up to date, and staying on costs one query an hour.
 *
 * The run takes fifteen to twenty minutes, almost all of it the rate rebuild,
 * so it is deliberately started detached from the request path.
 */

const checkIntervalMs = 60 * 60_000;
const startupDelayMs = 20_000;
// 09:00-09:30 KST, the half hour the domestic collector samples every minute.
const krOpeningFrom = 9 * 60;
const krOpeningTo = 9 * 60 + 30;

// Two sessions back, so a day the machine was off is still picked up, and a
// move worth spending a request on. Both are bounds on cost rather than
// findings - the request budget is five a minute and this runs beside a live
// collector.
const intradayDays = 2;
const intradayLimit = 60;
const intradayMinMove = 10;

// FINRA settles twice a month and publishes about eight business days later,
// so a fortnight without a new one is normal and three weeks is not.
const shortInterestMaxAgeDays = 21;
const shortVolumeLookbackDays = 5;

let running = false;

/**
 * The half hour this job must not start in.
 *
 * The hourly tick is phased to whenever the server started, and now that a
 * launcher starts it at logon rather than a person starting it before the bell,
 * that phase is not something anyone chooses. Sooner or later it lands on 09:0x
 * and a fifteen to twenty minute job begins competing with the per-minute
 * domestic sampling for the same pool.
 *
 * Yielding is free on this side and only on this side: the US session closed at
 * 05:00 KST, this is a once-a-day batch over daily bars, and a missed check is
 * retried an hour later with catchUpDays behind it, so the row that lands is
 * identical. A domestic minute not sampled at 09:07 does not come back.
 */
export function isKrOpeningWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = value("weekday");

  if (weekday === "Sat" || weekday === "Sun") return false;

  const minute = (Number(value("hour")) % 24) * 60 + Number(value("minute"));

  return minute >= krOpeningFrom && minute < krOpeningTo;
}

/**
 * The volume the live pass could not read.
 *
 * Yahoo carries no extended-hours volume, so a stock the collector watched
 * double overnight is stored with a price and nothing else. Massive has the
 * bars but only at five requests a minute, which is why it runs here after the
 * fact rather than in the collector: sixty names is twelve minutes, and the
 * names are chosen by how far they moved because out of hours that is the only
 * measure of size there is.
 */
async function fillIntraday(config) {
  const targets = await loadRecentTargets(config, {
    before: sessionDate("US"),
    days: intradayDays,
    limit: intradayLimit,
    minMove: intradayMinMove
  });

  if (targets.length === 0) return;

  console.log(`us intraday · ${targets.length} day(s) to fill`);

  const result = await fillUsIntraday(config, targets, { markMissing: false });

  console.log(`us intraday · ${result.fetched} filled · ${result.bars} bars`);
}

/**
 * Reference data nobody was refreshing.
 *
 * Both of these were written once by a script somebody ran by hand and then
 * left to age - the universe snapshot at nine samples in two years, the short
 * interest at whatever the backfill fetched. Neither reports being stale; they
 * just quietly describe an older market, which is how the eligible watchlist
 * came to be empty without anything failing.
 */
async function refreshReference(config) {
  const today = new Date().toISOString().slice(0, 10);

  try {
    const newest = await newestUniverseDate(config);

    if (isUniverseStale(newest, today)) {
      await refreshUsUniverse(config, universeSnapshotDate(today), { log: (message) => console.log(message) });
    }
  } catch (error) {
    console.warn("us universe refresh failed", error instanceof Error ? error.message : error);
  }

  // Before the short-interest block, which returns early when it is fresh.
  try {
    const stored = await storedShortVolumeDates(config);
    let saved = 0;

    // FINRA publishes the previous session the next morning, so a short look
    // back catches it without re-reading the archive the backfill already has.
    for (let back = 1; back <= shortVolumeLookbackDays; back += 1) {
      const date = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);

      if (stored.has(date)) continue;

      const rows = await loadShortVolume(date);

      if (rows.length === 0) continue;

      saved += await saveShortVolume(config, rows);
    }

    if (saved > 0) console.log(`us short volume · ${saved} rows`);
  } catch (error) {
    console.warn("us short volume refresh failed", error instanceof Error ? error.message : error);
  }

  try {
    const stored = await loadStoredSettlements(config);
    const newest = [...stored].sort().at(-1);
    const age = newest ? (new Date(`${today}T00:00:00Z`) - new Date(`${newest}T00:00:00Z`)) / 86400000 : Infinity;

    if (age < shortInterestMaxAgeDays) return;

    // Only the recent candidates. The two-year sweep is the backfill script's
    // job; this is here to notice a settlement that published since yesterday.
    const from = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);

    for (const date of settlementCandidates(from, today).filter((candidate) => !stored.has(candidate))) {
      const rows = await fetchShortInterest(config, date);

      if (rows.length === 0) continue;

      const saved = await saveShortInterest(config, rows);

      console.log(`us short interest · ${date} ${saved} rows`);
    }
  } catch (error) {
    console.warn("us short interest refresh failed", error instanceof Error ? error.message : error);
  }
}

async function tick(config) {
  if (running) return;
  if (isKrOpeningWindow()) return;

  try {
    if (!await hasUsPipelineTables(config)) return;

    // Ahead of the daily pipeline because it is the cheaper of the two and the
    // one whose input expires: the collector only keeps writing US samples
    // while the machine is on, and an unfilled mover is a price with no volume
    // beside it.
    // Set once and cleared in finally. Both jobs are long and the tick is
    // hourly, so the guard has to hold across the pair rather than be dropped
    // between them.
    running = true;

    await refreshReference(config);
    await fillIntraday(config);

    if (!await isUsPipelineDue(config)) return;

    await runUsDailyPipeline(config, { log: (message) => console.log(message) });
  } catch (error) {
    // A failed run must not take the server with it. The next tick retries, and
    // an hour is the right amount of backoff for a data source that publishes
    // once a day.
    console.warn("us pipeline failed", error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

export function startUsPipelineScheduler(config) {
  if (!config.usPipeline) return;

  console.log("us pipeline on · 매 시각 확인 · 분봉·참조데이터 갱신 포함 · 09:00–09:30 KST 제외");

  // Late enough that the server is answering requests before a twenty-minute
  // job starts competing with it for the connection pool.
  const first = setTimeout(() => tick(config), startupDelayMs);
  const timer = setInterval(() => tick(config), checkIntervalMs);

  first.unref?.();
  timer.unref?.();
}
