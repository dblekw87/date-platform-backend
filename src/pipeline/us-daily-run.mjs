import { query } from "../db/client.mjs";
import { calibrateUsSurges } from "./us-calibration.mjs";
import { fetchUsDailyBars, fetchUsSplits, isWeekend, isoDate, loadStoredSessions, shiftDays } from "./us-daily-bars.mjs";
import { fetchUsFilings, quarterOf } from "./us-filings.mjs";
import { refreshListedShares } from "./us-listed-shares.mjs";
import { labelUsSurges } from "./us-labels.mjs";

/**
 * One night's worth of the US surge pipeline.
 *
 * The candidate list is only as current as the close it was scored on, and a
 * board showing a week-old close is worse than one showing nothing: it reads as
 * today's answer. So the same four steps that built the two years of history
 * run again each morning, over one day instead of five hundred.
 *
 * Ordered by dependency, not by cost:
 *
 *   bars       the new session, plus any the last run missed
 *   splits     a reverse split renders a stock's history uncomparable, and the
 *              feed carries them a few days late
 *   shares     a rotating slice, oldest first — the whole set comes round in
 *              about a week, which is as stale as a share count may safely get
 *   filings    the current quarter's index, re-read because EDGAR appends to it
 *   labels     rebuilt whole, since the definition applies to every row
 *   rates      rebuilt whole for the same reason
 *
 * Shares go before labels and rates rather than after, because both are built
 * on turnover and turnover is volume divided by that count.
 *
 * Runs after the US close rather than before the Korean open, which are two
 * different clocks: 16:00 in New York is 05:00 in Seoul.
 */

const catchUpDays = 7;

export async function runUsDailyPipeline(config, { log = () => {} } = {}) {
  const started = Date.now();
  const to = shiftDays(isoDate(new Date()), -1);
  const from = shiftDays(to, -catchUpDays);
  const stored = await loadStoredSessions(config, from, to);
  const pending = [];

  for (let cursor = from; cursor <= to; cursor = shiftDays(cursor, 1)) {
    if (!isWeekend(cursor) && !stored.has(cursor)) pending.push(cursor);
  }

  // A week of catch-up rather than one day, because the machine this runs on is
  // a laptop that gets turned off. Sessions already stored cost nothing.
  log(`us pipeline · ${pending.length} session(s) to fetch`);

  let storedSessions = 0;

  if (pending.length > 0) {
    await fetchUsSplits(config, from, to);
    storedSessions = await fetchUsDailyBars(config, pending, {
      onSession: ({ barCount, sessionDate, status }) =>
        log(`us pipeline · ${sessionDate} ${status === "stored" ? `${barCount} bars` : status}`)
    });
  }

  // Nothing new means nothing to relabel. The rate rebuild is fifteen minutes
  // and the scheduler asks every hour, so a session that has not been published
  // yet would otherwise cost that fifteen minutes on every check until it is.
  if (storedSessions === 0) {
    log("us pipeline · 새 세션 없음 · 재계산 생략");

    return { buckets: 0, events: 0, sessions: 0 };
  }

  const shares = await refreshListedShares(config, { limit: config.usPipelineShareSlice });

  log(`us pipeline · 주식수 ${shares.fetched}종목 갱신 · ${shares.skipped}건 생략`);

  // EDGAR appends to the live quarter's index all quarter long, so it is the
  // one file that has to be re-read rather than skipped when present.
  await fetchUsFilings(config, [quarterOf(to)], {
    force: true,
    onQuarter: ({ count, quarter, status, year }) =>
      log(`us pipeline · filings ${year} ${quarter} ${status === "fetched" ? count : status}`)
  });

  const events = await labelUsSurges(config);

  log(`us pipeline · ${events} surge events`);

  const buckets = await calibrateUsSurges(config);

  log(`us pipeline · ${buckets} rate buckets · ${Math.round((Date.now() - started) / 1000)}s`);

  return { buckets, events, sessions: storedSessions };
}

/**
 * Whether the newest session in the database is the newest one there could be.
 *
 * Cheaper than a marker table and harder to get wrong: the bars themselves are
 * the record of what has been done.
 */
export async function isUsPipelineDue(config) {
  const to = shiftDays(isoDate(new Date()), -1);
  const stored = await loadStoredSessions(config, to, to);

  if (isWeekend(to)) {
    const friday = shiftDays(to, new Date(`${to}T00:00:00Z`).getUTCDay() === 6 ? -1 : -2);

    return (await loadStoredSessions(config, friday, friday)).size === 0;
  }

  return stored.size === 0;
}

export async function hasUsPipelineTables(config) {
  if (!config.databaseUrl) return false;

  try {
    await query(config, "SELECT 1 FROM us_backfill_progress LIMIT 1");

    return true;
  } catch {
    return false;
  }
}
