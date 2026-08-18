import { fetchShortInterest, loadStoredSettlements, saveShortInterest, settlementCandidates } from "../src/providers/short-interest.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * FINRA short interest for a date range, twice a month.
 *
 * Exists to answer one question the surge data raised and could not settle:
 * sub-dollar stocks are down a median 22% in the month before they explode, and
 * "short covering did it" is only one of the explanations that fits.
 *
 *   npm run us:short-interest
 *   npm run us:short-interest -- --from=2024-08-01 --to=2026-08-18
 */

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));

  return found ? found.slice(prefix.length) : fallback;
}

const config = readConfig();
const to = readArg("to", new Date().toISOString().slice(0, 10));
const from = readArg("from", new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10));
const stored = await loadStoredSettlements(config);
const candidates = settlementCandidates(from, to).filter((date) => !stored.has(date));

console.log(`${from} ~ ${to} · 후보 ${candidates.length}일 · 이미 보유 ${stored.size}일`);

let days = 0;
let rows = 0;

for (const [index, date] of candidates.entries()) {
  try {
    const fetched = await fetchShortInterest(config, date);

    if (fetched.length === 0) continue;

    const saved = await saveShortInterest(config, fetched);

    days += 1;
    rows += saved;
    console.log(`[${index + 1}/${candidates.length}] ${date} ${saved}건`);
  } catch (error) {
    console.warn(`[${index + 1}/${candidates.length}] ${date} 실패 ${error.message}`);
  }
}

console.log(`done · 정산일 ${days}일 · ${rows}건`);
process.exit(0);
