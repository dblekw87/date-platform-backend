import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";
import { fillFilingItems, recentItemTargets } from "../src/pipeline/us-filing-items.mjs";

/**
 * 8-K 항목 코드를 채웁니다.
 *
 *   node scripts/backfill-filing-items.mjs [--limit 500]     아직 한 번도 안 훑은 CIK부터 (초기 적재)
 *   node scripts/backfill-filing-items.mjs --recent 14        최근 14일에 8-K를 냈는데 items가 빈 CIK, 최신순
 *
 * 로직은 src/pipeline/us-filing-items.mjs에 있고 스케줄러가 매시 `--recent 3`에 해당하는
 * 것을 돕니다. 여기는 손으로 크게 메울 때 씁니다 -- 2026-09-09처럼 2주가 밀렸을 때.
 *
 * 왜 이걸 하냐면 -- 뉴스가 초소형주에 안 닿기 때문입니다. 2026-08-12 이후 급등 123종목
 * 중 우리 뉴스 피드가 다룬 것은 2개(AMLX, MRNA)뿐이었습니다. SEC는 의무라 전 종목이
 * 빠짐없이 들어옵니다. 그리고 3.01(상장유지요건 미달)은 급등의 8배 신호입니다.
 */

const config = readConfig();
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);

  return at >= 0 && args[at + 1] ? Number(args[at + 1]) : fallback;
};

const recentDays = option("--recent", null);
let ciks;

if (recentDays !== null) {
  ciks = await recentItemTargets(config, { days: recentDays, limit: 5000 });
  console.log(`\n최근 ${recentDays}일 8-K 중 items 빈 CIK ${ciks.length.toLocaleString("ko-KR")}개 · 예상 ${Math.round(ciks.length / 8 / 60)}분\n`);
} else {
  const limit = option("--limit", 6000);
  const { rows } = await query(config, `
    SELECT DISTINCT f.cik
      FROM us_filings f
      JOIN us_tickers t ON t.cik = f.cik AND t.active
     WHERE f.form_type LIKE '8-K%' AND f.filed_date >= '2024-08-01'
       AND NOT EXISTS (SELECT 1 FROM us_filing_item_progress p WHERE p.cik = f.cik)
     ORDER BY f.cik
     LIMIT $1`, [limit]);

  ciks = rows.map((row) => row.cik);
  console.log(`\n아직 안 훑은 CIK ${ciks.length.toLocaleString("ko-KR")}개 · 예상 ${Math.round(ciks.length / 8 / 60)}분\n`);
}

const result = await fillFilingItems(config, ciks, { log: (message) => console.log("  " + message) });

console.log(`\n끝 · CIK ${result.done.toLocaleString("ko-KR")}개 · 항목 채운 신고 ${result.filled.toLocaleString("ko-KR")}건 · 실패 ${result.failed}`);
process.exit(0);
