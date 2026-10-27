import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 자기주식취득결정 뒤 며칠 늦게 사도 남는 게 있나.
 *
 *   node scripts/measure-buyback-late-entry.mjs
 *
 * 2026-10-27 사용자 매매입니다. 삼성E&A가 10/23 실적+7,799억 매입·6,900억 소각을
 * 내고 첫날 +16%, 이후 사흘 더 오른 자리(D+2 장중)에서 "자사주 매입도 있으니
 * 내일까지" 들고 갔습니다. measure-buyback.mjs는 공시 당일 종가 진입만 봅니다.
 *
 * 진입은 공시 뒤 첫 거래일(D0)부터 k거래일 뒤 종가, 성적은 다음날 시가(갭)와
 * h거래일 뒤 종가에서 동일가중 시장을 뺀 초과입니다. "이미 오름"은 공시 전날
 * 종가 대비 진입 종가 +10% 이상입니다. 규모는 최신 시총 스냅샷이라 당시와 다를 수 있습니다.
 * k=0은 장 마감 뒤 공시가 섞여 갭에 공시 자체가 들어가므로 k>=1만 봅니다.
 *
 * 첫 결과(2025~, 10/27): 대형 2조+ 안 오른 칸(70건대)은 k=1~4 다음날 중앙
 * −0.33~−0.06, 상회 44~49% -- 늦게 사면 남는 게 없음. 대형 +10% 이미 오른 칸은
 * 다음날 중앙 −0.94~+3.00, 5일 +11~17이지만 **칸당 4~8건**이고 2026년 1~2월
 * 상승장(대덕·하이닉스·KB 등)에 몰려 판단 불가. 20건 쌓이면 다시 잽니다.
 */

const config = readConfig();

const { rows } = await query(config, `
  WITH d AS (
    SELECT DISTINCT ON (symbol, (filed_at AT TIME ZONE 'Asia/Seoul')::date)
           symbol, (filed_at AT TIME ZONE 'Asia/Seoul')::date AS fd
      FROM market_disclosures
     WHERE market = 'KR' AND title LIKE '%자기주식취득결정%' AND title NOT LIKE '%기재정정%' AND symbol IS NOT NULL
  ), b AS (
    SELECT symbol, session_date, open, close, row_number() OVER (PARTITION BY symbol ORDER BY session_date) AS rn
      FROM kr_daily_bars WHERE close > 0 AND open > 0
  ), daily AS (
    SELECT symbol, session_date,
           close / lag(close) OVER w - 1 AS r,
           lead(open) OVER (PARTITION BY symbol ORDER BY session_date) / close - 1 AS g
      FROM kr_daily_bars WHERE close > 0 AND open > 0
    WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ), mday AS (
    SELECT session_date, avg(r) FILTER (WHERE r BETWEEN -0.31 AND 0.31) AS r,
           avg(g) FILTER (WHERE g BETWEEN -0.31 AND 0.31) AS g
      FROM daily GROUP BY 1
  ), mkt AS (
    SELECT session_date, g, exp(sum(ln(1 + coalesce(r, 0))) OVER (ORDER BY session_date)) AS idx FROM mday
  ), d0 AS (
    SELECT d.symbol, b.rn AS rn0
      FROM d
      JOIN LATERAL (SELECT * FROM b WHERE b.symbol = d.symbol AND b.session_date >= d.fd ORDER BY session_date LIMIT 1) b ON true
     WHERE d.fd >= '2025-01-01'
  ), cap AS (
    SELECT DISTINCT ON (symbol) symbol, market_cap FROM kr_daily_universe ORDER BY symbol, session_date DESC
  ), x AS (
    SELECT kk.k, hh.h, cap.market_cap >= 2e12 AS large,
           (be.close / bp.close - 1) >= 0.10 AS ran,
           ((bn.open / be.close - 1) - me.g) * 100 AS gap_ex,
           ((bh.close / be.close - 1) - (mh.idx / me.idx - 1)) * 100 AS ex
      FROM d0
      CROSS JOIN (VALUES (0), (1), (2), (3), (4)) kk(k)
      CROSS JOIN (VALUES (1), (5)) hh(h)
      JOIN b bp ON bp.symbol = d0.symbol AND bp.rn = d0.rn0 - 1
      JOIN b be ON be.symbol = d0.symbol AND be.rn = d0.rn0 + kk.k
      JOIN b bn ON bn.symbol = d0.symbol AND bn.rn = d0.rn0 + kk.k + 1
      JOIN b bh ON bh.symbol = d0.symbol AND bh.rn = d0.rn0 + kk.k + hh.h
      JOIN mkt me ON me.session_date = be.session_date
      JOIN mkt mh ON mh.session_date = bh.session_date
      LEFT JOIN cap ON cap.symbol = d0.symbol
  )
  SELECT k, h, coalesce(large, false) AS large, ran, count(*)::int AS n,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_ex))::float8 AS gap_median,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY ex))::float8 AS median,
         avg(ex)::float8 AS avg,
         avg((ex > 0)::int)::float8 AS beat
    FROM x WHERE abs(ex) < 100 AND abs(gap_ex) < 100
   GROUP BY 1, 2, 3, 4 ORDER BY 3 DESC, 4 DESC, 2, 1`);

console.log("size  | ran10 | h | k |   n | gap med | median |    avg | beat");

for (const row of rows) {
  console.log([
    (row.large ? "2조+" : "small").padEnd(5),
    (row.ran ? "yes" : "no").padEnd(5),
    String(row.h),
    String(row.k),
    String(row.n).padStart(3),
    row.gap_median.toFixed(2).padStart(7),
    row.median.toFixed(2).padStart(6),
    row.avg.toFixed(2).padStart(6),
    `${Math.round(row.beat * 100)}%`.padStart(4)
  ].join(" | "));
}

process.exit(0);
