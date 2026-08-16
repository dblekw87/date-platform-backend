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

let running = false;

async function tick(config) {
  if (running) return;

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

  console.log("us pipeline on · 매 시각 확인, 전일 세션이 비어 있으면 실행");

  // Late enough that the server is answering requests before a twenty-minute
  // job starts competing with it for the connection pool.
  const first = setTimeout(() => tick(config), startupDelayMs);
  const timer = setInterval(() => tick(config), checkIntervalMs);

  first.unref?.();
  timer.unref?.();
}
