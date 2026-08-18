import { loadSessionSymbols } from "../src/db/repositories.mjs";
import { loadKrQuotes } from "../src/providers/kis.mjs";
import { readConfig } from "../src/config.mjs";
import { sessionDate } from "../src/providers/market-session.mjs";

/**
 * Why the after-hours pass only gets an answer for a third of its symbols.
 *
 * The first NXT evening, 2026-08-18, asked for 312 and stored 123. Two
 * explanations fit and they need opposite fixes: NXT lists a subset of the KRX
 * board, in which case the missing names should be dropped from the request, or
 * KIS is refusing on rate, in which case the pace has to slow down and dropping
 * anything would lose real data.
 *
 * They are distinguishable. A listing gap is deterministic - the same symbols
 * fail every time - while a rate limit is random, so a second pass fails on a
 * different set. Asking KRX for the same list separates the last case: a symbol
 * that answers on J and never on NX is not listed there.
 *
 * Run during the regular session, when both books are open and neither absence
 * can be blamed on the hour.
 *
 *   npm run probe:nxt-coverage
 */

const config = readConfig();
const date = process.argv.find((argument) => argument.startsWith("--date="))?.slice(7) ?? sessionDate("KR");
const symbols = await loadSessionSymbols(config, { market: "KR", sessionDate: date });

if (symbols.length === 0) {
  console.log(`\n${date} 표본이 없습니다.\n`);
  process.exit(0);
}

console.log(`\nNXT 커버리지 프로브 · ${date} · ${new Date().toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })}`);
console.log(`  대상 ${symbols.length}종목 · NX 두 번, J 한 번\n`);

async function answered(venue, label) {
  const quotes = await loadKrQuotes(config, symbols, venue);
  const set = new Set(quotes.map((quote) => quote.symbol));

  console.log(`  ${label.padEnd(8)} ${String(set.size).padStart(4)} / ${symbols.length} 응답`);

  return set;
}

const firstNx = await answered("NX", "NX 1차");
const secondNx = await answered("NX", "NX 2차");
const onJ = await answered("J", "J");

const missedTwice = symbols.filter((symbol) => !firstNx.has(symbol) && !secondNx.has(symbol));
const missedOnce = symbols.filter((symbol) => firstNx.has(symbol) !== secondNx.has(symbol));
// The decisive set: KRX knows them, NXT never did.
const jOnly = missedTwice.filter((symbol) => onJ.has(symbol));

console.log("");
console.log(`  NX 두 번 다 실패      ${String(missedTwice.length).padStart(4)}종목`);
console.log(`  NX 한 번만 실패       ${String(missedOnce.length).padStart(4)}종목`);
console.log(`  그중 J로는 응답       ${String(jOnly.length).padStart(4)}종목`);
console.log("");

if (missedTwice.length > 0 && missedOnce.length * 4 < missedTwice.length) {
  console.log("  → 미상장으로 읽힙니다. 실패가 반복되고 무작위 실패는 적습니다.");
  console.log("     애프터마켓 대상에서 이 종목들을 빼면 요청이 줄고 응답률이 올라갑니다.");
} else if (missedOnce.length > 0 && missedOnce.length * 2 >= missedTwice.length) {
  console.log("  → 레이트 리밋으로 읽힙니다. 두 번의 실패 집합이 서로 다릅니다.");
  console.log("     종목을 빼면 안 되고, 요청 페이스를 늦춰야 합니다.");
} else {
  console.log("  → 판정이 갈리지 않습니다. 두 원인이 섞였을 수 있습니다.");
}

if (jOnly.length > 0) {
  console.log(`\n  J로만 답한 종목 (앞 15개): ${jOnly.slice(0, 15).join(", ")}`);
}

console.log("");
process.exit(0);
