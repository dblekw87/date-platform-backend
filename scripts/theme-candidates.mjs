import { buildThemeCandidates, formatThemeCandidates } from "../src/providers/theme-candidates.mjs";
import { readConfig } from "../src/config.mjs";
import { sessionDate } from "../src/providers/market-session.mjs";

/**
 * The theme candidate report for one session, on demand.
 *
 * The collector writes the same report to logs/ at every close, so this is for
 * looking at a day that has already passed or for trying different thresholds
 * against it. Everything it reads is stored, so any past session can be asked
 * for at any time.
 *
 *   npm run theme:candidates
 *   npm run theme:candidates -- --date=2026-08-18 --min-move=5 --min-ticks=6
 */

function readOption(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));

  return match ? match.slice(prefix.length) : fallback;
}

const config = readConfig();
const date = readOption("date", sessionDate("KR"));
const report = await buildThemeCandidates(config, date, {
  minCorrelation: Number(readOption("min-correlation", "0.6")),
  minMove: Number(readOption("min-move", "5")),
  minTicks: Number(readOption("min-ticks", "6"))
});

console.log("");

if (report.symbols === 0) console.log(`${date} 시세 표본이 없습니다.\n`);
else console.log(formatThemeCandidates(report));

process.exit(0);
