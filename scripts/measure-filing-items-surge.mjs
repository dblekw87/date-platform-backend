import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 8-K 항목 코드가 급등을 예고하는가.
 *
 *   node scripts/measure-filing-items-surge.mjs
 *
 * `measure-filing-surge.mjs`가 서식 종류로 갈랐을 때 8-K는 전 회전율 구간에서
 * 1.0x였습니다 -- 신호 없음. 같은 조건에서 424B4는 회전율 0~1% 구간 20배였습니다.
 *
 * 8-K가 뭉개진 것일 수 있습니다. 실적 발표(2.02), 중요 계약(1.01), 미등록 증권
 * 매각(3.02, 곧 희석), 임원 변경(5.02)이 전부 같은 "8-K"로 세어졌으니까요. 항목
 * 코드를 채우고 그 안에서 갈리는지 봅니다.
 *
 * 검정은 앞선 것과 같습니다 -- **회전율로 통제한 뒤에도 배수가 남는가.** 통제 없이
 * 재면 "공시를 자주 내는 회사가 급등도 자주 한다"를 발견하고 끝납니다.
 *
 * 한 신고가 항목을 여럿 답니다("5.02,9.01"). 쪼개서 각각 세므로 합이 신고 수보다
 * 큽니다. 9.01(첨부문서)은 거의 모든 8-K에 붙어 뜻이 없으니 뺍니다.
 */

const config = readConfig();
const horizon = 5;

const { rows } = await query(config, `
  WITH ticker AS (
    SELECT DISTINCT ON (cik) cik, symbol FROM us_tickers
     WHERE active AND cik IS NOT NULL ORDER BY cik, symbol
  ),
  shares AS (
    SELECT DISTINCT ON (symbol) symbol, shares FROM us_listed_shares
     WHERE shares >= 100000 ORDER BY symbol, as_of DESC
  ),
  bars AS (
    SELECT b.symbol, b.session_date,
           CASE WHEN b.volume / s.shares < 0.01 THEN '0~1%'
                WHEN b.volume / s.shares < 0.05 THEN '1~5%'
                WHEN b.volume / s.shares < 0.20 THEN '5~20%'
                ELSE '20%+' END AS bucket
      FROM us_daily_bars b
      JOIN shares s ON s.symbol = b.symbol
     WHERE b.close * b.volume >= 100000 AND b.close >= 0.1
       AND b.session_date >= '2024-09-01'
  ),
  surged AS (
    SELECT DISTINCT b.symbol, b.session_date
      FROM bars b JOIN us_surge_events e
        ON e.symbol = b.symbol
       AND e.session_date > b.session_date
       AND e.session_date <= b.session_date + ${horizon}
  ),
  -- "5.02,9.01"을 두 행으로 펼칩니다. 첨부문서(9.01)는 거의 모든 8-K에 붙어
  -- 구분하는 힘이 없으므로 뺍니다.
  filed AS (
    SELECT DISTINCT t.symbol, f.filed_date, trim(item) AS item
      FROM us_filings f
      JOIN ticker t ON t.cik = f.cik
      CROSS JOIN LATERAL unnest(string_to_array(f.items, ',')) AS item
     WHERE f.items IS NOT NULL AND f.filed_date >= '2024-08-25'
       AND trim(item) <> '9.01'
  )
  SELECT b.bucket, coalesce(fl.item, '(8-K 없음)') AS item,
         count(*) AS n,
         count(*) FILTER (WHERE s.symbol IS NOT NULL) AS hits
    FROM bars b
    LEFT JOIN surged s ON s.symbol = b.symbol AND s.session_date = b.session_date
    LEFT JOIN filed fl ON fl.symbol = b.symbol
                      AND fl.filed_date BETWEEN b.session_date - 1 AND b.session_date
   GROUP BY 1, 2
`);

const num = (v) => Number(v);
const buckets = ["0~1%", "1~5%", "5~20%", "20%+"];
const cell = new Map(rows.map((r) => [`${r.bucket}|${r.item}`, { hits: num(r.hits), n: num(r.n) }]));
const bucketTotal = (b) => rows.filter((r) => r.bucket === b)
  .reduce((a, r) => ({ hits: a.hits + num(r.hits), n: a.n + num(r.n) }), { hits: 0, n: 0 });

const names = {
  "1.01": "중요 계약 체결", "1.02": "중요 계약 종료", "2.01": "자산 취득·처분",
  "2.02": "실적 발표", "2.03": "채무 발생", "3.01": "상장폐지 통보",
  "3.02": "미등록 증권 매각", "4.01": "감사인 변경", "5.02": "임원 변경",
  "5.03": "정관 변경", "7.01": "Reg FD 공개", "8.01": "기타 사항"
};

// 표본이 너무 적은 항목은 답이 못 됩니다.
const items = [...new Set(rows.map((r) => r.item))]
  .filter((item) => item !== "(8-K 없음)")
  .map((item) => ({ item, n: buckets.reduce((a, b) => a + (cell.get(`${b}|${item}`)?.n ?? 0), 0) }))
  .filter((x) => x.n >= 2000)
  .sort((a, b) => b.n - a.n)
  .map((x) => x.item);

console.log("");
console.log(`2024-09 ~ 2026-08 · 앞으로 ${horizon}일 안에 급등(고가 기준)했는가`);
console.log(`회전율로 통제. 한 신고가 항목을 여럿 달므로 합이 신고 수보다 큽니다.`);
console.log("");
console.log("  회전율 구간별 기준선");
buckets.forEach((b) => {
  const t = bucketTotal(b);

  console.log(`    ${b.padEnd(7)} ${(t.hits / t.n * 100).toFixed(2)}%  (표본 ${t.n.toLocaleString("ko-KR")})`);
});

console.log("");
console.log("  8-K 항목                        " + buckets.map((b) => b.padEnd(16)).join(""));

for (const item of [...items, "(8-K 없음)"]) {
  const label = item === "(8-K 없음)" ? item : `${item} ${names[item] ?? ""}`;
  const cells = buckets.map((b) => {
    const c = cell.get(`${b}|${item}`);

    if (!c || c.n < 100) return "-".padEnd(16);

    const t = bucketTotal(b);

    return `${(c.hits / c.n * 100).toFixed(1)}% ${((c.hits / c.n) / (t.hits / t.n)).toFixed(2)}x`.padEnd(16);
  });

  console.log(`  ${label.padEnd(30)}` + cells.join(""));
}

console.log("");
console.log("  ※ 배수는 그 회전율 구간의 기준선 대비입니다. 1.0x면 아무 정보도 없다는 뜻입니다.");
process.exit(0);
