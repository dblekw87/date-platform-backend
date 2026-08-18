import { fillUsIntraday, loadEventTargets, loadRecentTargets } from "../src/pipeline/us-intraday.mjs";
import { readConfig } from "../src/config.mjs";
import { sessionDate } from "../src/providers/market-session.mjs";

/**
 * Five-minute bars for surge days, pre-market and after hours included.
 *
 * The scheduler runs the "recent" pass on its own once a US session closes, so
 * this is for the history sweep and for asking again with different bounds.
 *
 *   npm run us:intraday                          # 400 largest events not yet fetched
 *   npm run us:intraday -- --limit=100
 *   npm run us:intraday -- --min-gain=1.0 --limit=800
 *   npm run us:intraday -- --source=recent       # what the collector saw move
 *   npm run us:intraday -- --source=recent --days=3 --min-move=10
 */

const config = readConfig();

if (!config.massive.apiKey) {
  console.error("MASSIVE_API_KEY is not set. Add it to date-platform-backend/.env and rerun.");
  process.exit(1);
}

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));

  return found ? found.slice(prefix.length) : fallback;
}

const source = readArg("source", "events");
const limit = Number(readArg("limit", "400"));
const targets = source === "recent"
  ? await loadRecentTargets(config, {
    before: sessionDate("US"),
    days: Number(readArg("days", "2")),
    limit,
    minMove: Number(readArg("min-move", "10"))
  })
  : await loadEventTargets(config, { limit, minGain: Number(readArg("min-gain", "2.0")) });
const intervalMs = Math.ceil(60_000 / Math.max(config.massive.requestsPerMinute, 1));

console.log(`${targets.length} ${source} day(s) to fetch at ${config.massive.requestsPerMinute}/min`);
console.log(`estimated ${Math.ceil((targets.length * intervalMs) / 60_000)} minutes`);

const result = await fillUsIntraday(config, targets, {
  log: (message) => console.log(message),
  markMissing: source !== "recent"
});

console.log(`done · ${result.fetched} fetched · ${result.bars} bars`);
process.exit(0);
