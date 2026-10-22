import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 자기주식취득결정 뒤 주가, 소각 동반 여부와 규모로 나눠서.
 *
 *   node scripts/measure-buyback.mjs
 *
 * 2026-10-22 사용자 질문입니다. 삼성E&A가 7,799억 매입(시총 약 8%)과 6,900억
 * 소각을 08:05/08:18에 내고 +16% 갔고, "소각까지 하면 많이 오르나"를 물었습니다.
 *
 * 진입은 공시일 종가(장 밖 공시면 다음 거래일 종가), 성적은 h거래일 뒤 종가에서
 * 동일가중 시장을 뺀 초과입니다. 소각은 같은 종목 "주식소각결정"이 ±1일 안에
 * 있는지로만 봅니다 -- 제목 기준이라 나중에 소각한 건은 미소각 칸에 섞입니다.
 * 규모는 최신 시총 스냅샷(kr_daily_universe, 8/21~)이라 공시 당시와 다를 수 있습니다.
 *
 * 첫 결과(2025~, 414건): 대형 2조+는 소각 동반 20일 중앙 +1.43/61% 대 미소각
 * +1.99/53%로 칸당 30~50건이라 가를 수 없음. 중소형은 소각 쪽이 오히려 약함.
 */

const config = readConfig();

const { rows } = await query(config, `
  WITH d AS (
    SELECT DISTINCT ON (symbol, (filed_at AT TIME ZONE 'Asia/Seoul')::date)
           symbol, (filed_at AT TIME ZONE 'Asia/Seoul')::date AS fd
      FROM market_disclosures
     WHERE market = 'KR' AND title LIKE '%자기주식취득결정%' AND title NOT LIKE '%기재정정%' AND symbol IS NOT NULL
  ), burn AS (
    SELECT DISTINCT symbol, (filed_at AT TIME ZONE 'Asia/Seoul')::date AS bd
      FROM market_disclosures
     WHERE market = 'KR' AND title LIKE '%주식소각결정%' AND title NOT LIKE '%기재정정%' AND symbol IS NOT NULL
  ), b AS (
    SELECT symbol, session_date, close, row_number() OVER (PARTITION BY symbol ORDER BY session_date) AS rn
      FROM kr_daily_bars WHERE close > 0 AND open > 0
  ), mkt AS (
    SELECT session_date, exp(sum(ln(1 + r)) OVER (ORDER BY session_date)) AS idx FROM (
      SELECT session_date, avg(r) AS r FROM (
        SELECT session_date, close / lag(close) OVER (PARTITION BY symbol ORDER BY session_date) - 1 AS r
          FROM kr_daily_bars WHERE close > 0 AND open > 0
      ) z WHERE r BETWEEN -0.31 AND 0.31 GROUP BY 1
    ) y
  ), e AS (
    SELECT d.symbol, b.session_date AS ed, b.close AS c0, b.rn,
           EXISTS (SELECT 1 FROM burn WHERE burn.symbol = d.symbol AND burn.bd BETWEEN d.fd - 1 AND d.fd + 1) AS burned
      FROM d
      JOIN LATERAL (SELECT * FROM b WHERE b.symbol = d.symbol AND b.session_date >= d.fd ORDER BY session_date LIMIT 1) b ON true
     WHERE d.fd >= '2025-01-01'
  ), cap AS (
    SELECT DISTINCT ON (symbol) symbol, market_cap FROM kr_daily_universe ORDER BY symbol, session_date DESC
  ), x AS (
    SELECT hh.h, e.burned, cap.market_cap >= 2e12 AS large,
           ((b2.close / e.c0 - 1) - (m2.idx / m0.idx - 1)) * 100 AS ex
      FROM e
      CROSS JOIN (VALUES (5), (10), (20)) hh(h)
      JOIN b b2 ON b2.symbol = e.symbol AND b2.rn = e.rn + hh.h
      JOIN mkt m0 ON m0.session_date = e.ed
      JOIN mkt m2 ON m2.session_date = b2.session_date
      LEFT JOIN cap ON cap.symbol = e.symbol
  )
  SELECT h, burned, coalesce(large, false) AS large, count(*)::int AS n,
         avg(ex)::float8 AS avg,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY ex))::float8 AS median,
         avg((ex > 0)::int)::float8 AS beat
    FROM x WHERE abs(ex) < 100
   GROUP BY 1, 2, 3 ORDER BY 3 DESC, 2 DESC, 1`);

console.log("size  | burn | h  |   n |    avg | median | beat");

for (const row of rows) {
  console.log([
    (row.large ? "2조+" : "small").padEnd(5),
    (row.burned ? "yes" : "no").padEnd(4),
    String(row.h).padStart(2),
    String(row.n).padStart(3),
    row.avg.toFixed(2).padStart(6),
    row.median.toFixed(2).padStart(6),
    `${Math.round(row.beat * 100)}%`.padStart(4)
  ].join(" | "));
}

process.exit(0);
