import { readConfig } from "../src/config.mjs";
import { isUsPipelineDue, runUsDailyPipeline } from "../src/pipeline/us-daily-run.mjs";

/**
 * Runs the nightly rebuild once, now. Same function the scheduler calls.
 *
 * Usage:
 *   npm run us:daily          # skip if yesterday's session is already stored
 *   npm run us:daily -- --force
 */

const config = readConfig();
const force = process.argv.includes("--force");

if (!force && !await isUsPipelineDue(config)) {
  console.log("us pipeline · 최신 상태입니다 (--force로 강제 실행)");
  process.exit(0);
}

await runUsDailyPipeline(config, { log: (message) => console.log(message) });

process.exit(0);
