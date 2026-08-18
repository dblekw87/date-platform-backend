import { hasUsPipelineTables, isUsPipelineDue, runUsDailyPipeline } from "./us-daily-run.mjs";

/**
 * Keeps the US surge data current without anyone remembering to.
 *
 * Not a cron. The machine this runs on is a laptop that is off overnight, so a
 * fixed 07:00 firing would simply be missed on the mornings it matters. Instead
 * the check is "is yesterday's session in the database", asked once at startup
 * and every hour after — which means turning the laptop on at any hour brings
 * the board up to date, and leaving it on all day costs one query an hour.
 *
 * The run takes fifteen to twenty minutes, almost all of it the rate rebuild,
 * so it is deliberately started detached from the request path.
 */

const checkIntervalMs = 60 * 60_000;
const startupDelayMs = 20_000;
// 09:00-09:30 KST, the half hour the domestic collector samples every minute.
const krOpeningFrom = 9 * 60;
const krOpeningTo = 9 * 60 + 30;

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

async function tick(config) {
  if (running) return;
  if (isKrOpeningWindow()) return;

  try {
    if (!await hasUsPipelineTables(config)) return;
    if (!await isUsPipelineDue(config)) return;

    running = true;
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

  console.log("us pipeline on · 매 시각 확인, 전일 세션이 비어 있으면 실행 · 09:00–09:30 KST 제외");

  // Late enough that the server is answering requests before a twenty-minute
  // job starts competing with it for the connection pool.
  const first = setTimeout(() => tick(config), startupDelayMs);
  const timer = setInterval(() => tick(config), checkIntervalMs);

  first.unref?.();
  timer.unref?.();
}
