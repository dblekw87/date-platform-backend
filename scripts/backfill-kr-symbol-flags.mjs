import { loadCorpIndex } from "../src/providers/industry.mjs";
import { loadKrQuotes } from "../src/providers/kis.mjs";
import { loadSessionSymbols, saveSymbolFlags } from "../src/db/repositories.mjs";
import { sessionDate } from "../src/providers/market-session.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 시장 지정을 하루치 소급 수집합니다.
 *
 * 수집기는 정규장 동안만 전 종목을 훑으므로, 지정 정보를 붙인 날 저녁에는 오늘치가
 * 비어 있습니다. 이 스크립트가 그 하루를 메웁니다. 평소에는 필요 없습니다.
 *
 *   npm run kr:flags
 *   npm run kr:flags -- --date=2026-08-19
 */

function readOption(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));

  return match ? match.slice(prefix.length) : fallback;
}

const config = readConfig();
const day = readOption("date", sessionDate("KR"));
const symbols = await loadSessionSymbols(config, { market: "KR", sessionDate: day });

console.log(`\n시장 지정 · ${day} · ${symbols.length}종목`);

if (symbols.length === 0) {
  console.log("  그날 본 종목이 없습니다.\n");
  process.exit(0);
}

// The regular-session book, because a designation is the exchange's and NXT
// does not list most of these names.
const quotes = await loadKrQuotes(config, symbols, "J");
// KIS inquire-price returns no company name, so the quote falls back to its own
// code. DART's index is already cached for the industry lookup.
const names = await loadCorpIndex(config).then((index) =>
  new Map(Object.entries(index).map(([symbol, entry]) => [symbol, entry.corpName]))).catch(() => new Map());
const saved = await saveSymbolFlags(config, { sessionDate: day, stocks: quotes });
const designated = quotes.filter((quote) => quote.flags
  && (quote.flags.marketWarn !== "00" || quote.flags.managed || quote.flags.halted
    || quote.flags.liquidation || quote.flags.shortOverheated || quote.flags.investmentCaution));

console.log(`  ${quotes.length}종목 응답 · ${saved}행 저장 · 지정된 종목 ${designated.length}개\n`);

designated
  .sort((left, right) => (right.changeRateValue ?? 0) - (left.changeRateValue ?? 0))
  .forEach((quote) => {
    const labels = [
      { "01": "투자주의", "02": "투자경고", "03": "투자위험" }[quote.flags.marketWarn],
      quote.flags.managed ? "관리종목" : null,
      quote.flags.halted ? "거래정지" : null,
      quote.flags.liquidation ? "정리매매" : null,
      quote.flags.shortOverheated ? "단기과열" : null,
      quote.flags.investmentCaution ? "투자유의" : null
    ].filter(Boolean);

    console.log(`  ${String(names.get(quote.symbol) ?? quote.symbol).padEnd(16)} ${String((quote.changeRateValue ?? 0).toFixed(2)).padStart(7)}%  ${labels.join(" · ")}`);
  });

console.log("");
process.exit(0);
