import { loadCorpIndex } from "../src/providers/industry.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * A stock code from a company name, so nobody has to remember one.
 *
 * Written after guessing four of them wrong in two days. 푸른기술 turned out to
 * be 푸른로보틱스, 파나시아 was 자안바이오, and reading two names off a broker's
 * screen produced 214430 for 아이윈 (090150) and 009240 for 한켐 (457370) - the
 * last two "missing from our data", which were in it the whole time under codes
 * nobody had checked.
 *
 * Every one of those was caught by looking the code up afterwards. This is the
 * lookup, done first.
 *
 * DART's corporation index is already downloaded for the industry map, so this
 * reads the archive rather than fetching anything.
 *
 *   npm run find -- 아이윈
 *   npm run find -- 한켐 푸른 파나시아
 */

const config = readConfig();
const terms = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));

if (terms.length === 0) {
  console.log("\n사용법: npm run find -- <종목명 일부> [종목명 ...]\n");
  process.exit(1);
}

const index = await loadCorpIndex(config);
const listed = Object.entries(index).filter(([symbol]) => /^\w{6}$/.test(symbol));

console.log(`\n상장 종목 ${listed.length.toLocaleString("ko-KR")}개에서 검색\n`);

for (const term of terms) {
  // Exact first, because a short term matches a lot and the exact hit is
  // almost always the one meant.
  const hits = listed.filter(([, entry]) => String(entry.corpName ?? "").includes(term));
  const exact = hits.filter(([, entry]) => entry.corpName === term);
  const shown = exact.length > 0 ? exact : hits;

  if (shown.length === 0) {
    console.log(`  ${term.padEnd(14)} 없음`);
    continue;
  }

  shown.slice(0, 8).forEach(([symbol, entry], index2) => {
    console.log(`  ${(index2 === 0 ? term : "").padEnd(14)} ${symbol}  ${entry.corpName}`);
  });

  if (shown.length > 8) console.log(`  ${"".padEnd(14)} … 외 ${shown.length - 8}건`);
}

console.log("");
process.exit(0);
