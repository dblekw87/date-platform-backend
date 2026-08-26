import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 공시 종류가 급등을 예고하는가 -- 초소형주까지 덮는 유일한 소스로.
 *
 *   node scripts/measure-filing-surge.mjs
 *
 * 계기: 뉴스가 급등을 예고하지 않는다는 결론([[us-surge-findings]])을 다시 읽어보니
 * 그것은 뉴스가 **닿는 종목 안에서만** 잰 값이었습니다. 2026-08-12 이후 급등한
 * 123종목 중 우리 뉴스 피드가 다룬 것은 2개(AMLX, MRNA)뿐입니다. 급등은 XHG·WFF·
 * ZSTK 같은 초소형주에서 나는데 Reuters와 MarketBeat는 그런 종목을 쓰지 않습니다.
 *
 * SEC 공시는 다릅니다. 신고 의무라 전 종목이 빠짐없이 들어오고, 2년치가 이미
 * 받아져 있습니다.
 *
 * 재는 방식은 [[us-surge-findings]]의 검정을 따릅니다 -- 회전율을 통제한 뒤에도
 * 배수가 남는가. 통제 없이 재면 "공시를 많이 내는 회사가 급등도 많이 한다"를
 * 발견하고 끝납니다.
 *
 * 급등 정의는 us_surge_events가 이미 쓰는 것을 그대로 씁니다(고가 기준).
 */

const config = readConfig();
const horizon = 5;

const forms = ["8-K", "424B4", "424B5", "S-1", "S-3", "6-K", "425", "SC 13D"];

/*
 * 전부 SQL 안에서 셉니다. 처음에는 2백만 행을 JS로 끌어와 세다가 10분을 넘겼습니다 --
 * 행마다 도는 상관 서브쿼리가 둘이었고, 그중 하나는 270만 건짜리 공시 표였습니다.
 */
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
  -- 급등 표가 6,810건뿐이라 범위 조인이 싸게 끝납니다.
  surged AS (
    SELECT DISTINCT b.symbol, b.session_date
      FROM bars b JOIN us_surge_events e
        ON e.symbol = b.symbol
       AND e.session_date > b.session_date
       AND e.session_date <= b.session_date + ${horizon}
  ),
  -- 관심 있는 종류만 먼저 걸러 270만 건을 줄입니다.
  filed AS (
    SELECT DISTINCT t.symbol, f.filed_date, f.form_type
      FROM us_filings f JOIN ticker t ON t.cik = f.cik
     WHERE f.filed_date >= '2024-08-25' AND f.form_type = ANY($1::text[])
  )
  SELECT b.bucket, coalesce(fl.form_type, '(없음)') AS form,
         count(*) AS n,
         count(*) FILTER (WHERE s.symbol IS NOT NULL) AS hits
    FROM bars b
    LEFT JOIN surged s ON s.symbol = b.symbol AND s.session_date = b.session_date
    LEFT JOIN filed fl ON fl.symbol = b.symbol
                      AND fl.filed_date BETWEEN b.session_date - 1 AND b.session_date
   GROUP BY 1, 2
`, [forms]);

const num = (v) => Number(v);
const buckets = ["0~1%", "1~5%", "5~20%", "20%+"];
const byBucket = new Map();

for (const r of rows) {
  const key = `${r.bucket}|${r.form}`;
  byBucket.set(key, { hits: num(r.hits), n: num(r.n) });
}
const bucketTotal = (b) => rows.filter((r) => r.bucket === b)
  .reduce((a, r) => ({ hits: a.hits + num(r.hits), n: a.n + num(r.n) }), { hits: 0, n: 0 });

console.log("");
console.log(`2024-09 ~ 2026-08 · 앞으로 ${horizon}일 안에 급등(고가 기준)했는가`);
console.log(`회전율로 통제 -- 통제 없이 재면 "공시 잦은 회사가 급등도 잦다"를 발견하고 끝납니다`);
console.log("");
console.log("  회전율 구간별 기준선");
buckets.forEach((b) => {
  const t = bucketTotal(b);
  console.log(`    ${b.padEnd(7)} ${(t.hits / t.n * 100).toFixed(2)}%  (표본 ${t.n.toLocaleString("ko-KR")})`);
});

console.log("");
console.log("  공시 종류      " + buckets.map((b) => b.padEnd(16)).join(""));
for (const form of [...forms, "(없음)"]) {
  const cells = buckets.map((b) => {
    const cell = byBucket.get(`${b}|${form}`);
    if (!cell || cell.n < 100) return "-".padEnd(16);
    const t = bucketTotal(b);
    const mult = (cell.hits / cell.n) / (t.hits / t.n);
    return `${(cell.hits / cell.n * 100).toFixed(1)}% ${mult.toFixed(2)}x`.padEnd(16);
  });
  console.log(`  ${form.padEnd(14)}` + cells.join(""));
}

process.exit(0);
