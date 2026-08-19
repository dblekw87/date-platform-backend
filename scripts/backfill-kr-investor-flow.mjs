import { collectInvestorFlow } from "../src/providers/investor-flow.mjs";
import { loadSessionSymbols } from "../src/db/repositories.mjs";
import { readConfig } from "../src/config.mjs";
import { sessionDate } from "../src/providers/market-session.mjs";

/**
 * Who bought today, collected after the close.
 *
 * KIS returns thirty sessions per symbol, so a first run backfills a month of
 * history for every name the collector has seen. Today's row is blank until the
 * session settles - run it after 15:40.
 *
 *   npm run kr:investor-flow
 *   npm run kr:investor-flow -- --date=2026-08-19
 */

function readOption(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));

  return match ? match.slice(prefix.length) : fallback;
}

const config = readConfig();
const day = readOption("date", sessionDate("KR"));
const symbols = await loadSessionSymbols(config, { market: "KR", sessionDate: day });

console.log(`${day} · ${symbols.length}종목 · 종목당 1요청`);

const result = await collectInvestorFlow(config, symbols, { log: (message) => console.log(message) });

console.log(`done · ${result.saved} rows`);
process.exit(0);
