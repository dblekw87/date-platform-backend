import { getPool } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 공매도·대차가 국내 종목의 다음 날 시가와 5일 초과를 가르는가.
 *
 *   node scripts/measure-short-lending.mjs
 *
 * 2026-10-23 사용자 가설입니다. 삼성E&A 대차잔고가 +27% 오르는 동안 그대로인 걸 보고
 * "소형주는 공매도·대차로 예측 가능할 것 같다", "공매도가 없으면 잘 안 오를 것 같다"고
 * 했습니다. 표는 backfill-kr-short-lending이 채웁니다(2025-03-31 재개 이후).
 *
 * 초과는 같은 날 동일가중 평균을 뺀 값입니다(open > 0, ±31% 밖 제외). 규모는 최신 시총을
 * 그날 종가로 되돌린 근사이고 대형 1조↑, 중형 3천억↑. 대금 10억+.
 *
 * 첫 결과(2026-10-24, 소형 약 21만 종목·일):
 *   - 공매도 비중 평소 대비 4배↑: 다음 날 중앙 −0.13/43%, 5일 −2.01/38% — 평소(−0.12/44%,
 *     −1.86/38%)와 같음. 대형·중형도 칸끼리 차이 없음.
 *   - 대차잔고 5일 30%↓ 감소(숏커버): 5일 −2.24/37% 대 ±10% −1.81/39% — 없음.
 *   - 잔고가 거래량 며칠치인가(숏커버 연료): 다음 날 중앙 −0.10~−0.15로 같음.
 *   - 대차 있는 날은 5일 안 +15% 급등이 두 배(11.2% 대 5.5%)지만 5일 평균은 더 나쁨
 *     (−0.49 대 +0.43). 달별로 11/19달만 같은 방향이라 신호가 아니라 "거친 종목" 표시.
 *   "새로 생김" 칸의 대형 −2.83은 lag 5가 비는 2025-04 첫 주(관세 급락)라 버릴 것.
 */

const config = readConfig();
const client = await getPool(config).connect();

const setup = [
  `
CREATE TEMP TABLE b AS
SELECT symbol, session_date d, open, close, volume,
       lead(open) OVER w AS o1, close / nullif(lag(close,20) OVER w,0) - 1 AS r20, stddev(close/nullif(open,0)) OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS vol20, lead(close,5) OVER w AS c5,
       greatest(lead(close,1) OVER w, lead(close,2) OVER w, lead(close,3) OVER w, lead(close,4) OVER w, lead(close,5) OVER w) AS maxc5,
       avg(volume) OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS v20
  FROM kr_daily_bars WHERE close > 0 AND open > 0 AND session_date >= '2025-03-01'
WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  `,
  `
CREATE TEMP TABLE mg AS
SELECT d, avg(o1/close-1) g1, avg(c5/close-1) g5 FROM b
 WHERE o1 > 0 AND c5 > 0 AND abs(o1/close-1) < 0.31 AND abs(c5/close-1) < 1 GROUP BY d
  `,
  `
CREATE TEMP TABLE cap AS
SELECT DISTINCT ON (u.symbol) u.symbol, u.market_cap, u.session_date cd FROM kr_daily_universe u WHERE market_cap > 0 ORDER BY u.symbol, u.session_date DESC
  `,
  `
CREATE TEMP TABLE s AS
SELECT symbol, session_date d, short_ratio sr,
       avg(short_ratio) OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) sr20,
       count(*) OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) n20
  FROM kr_short_sale
  `,
  `
CREATE TEMP TABLE l AS
SELECT symbol, session_date d, balance_qty bal, lag(balance_qty,5) OVER (PARTITION BY symbol ORDER BY session_date) bal5
  FROM kr_stock_lending
  `,
  `
CREATE TEMP TABLE x AS
SELECT b.symbol, b.d,
       CASE WHEN c.market_cap * b.close / cb.close >= 1e12 THEN '1대형' WHEN c.market_cap * b.close / cb.close >= 3e11 THEN '2중형' ELSE '3소형' END sz,
       s.sr, s.sr20, s.n20, l.bal, l.bal5, b.v20,
       (b.o1/b.close-1 - mg.g1)*100 ex1, (b.c5/b.close-1 - mg.g5)*100 ex5,
       b.maxc5 >= b.close*1.15 AS jump15, b.r20, b.vol20
  FROM b JOIN mg USING (d)
  JOIN cap c ON c.symbol = b.symbol
  JOIN kr_daily_bars cb ON cb.symbol = c.symbol AND cb.session_date = c.cd
  LEFT JOIN s ON s.symbol = b.symbol AND s.d = b.d
  LEFT JOIN l ON l.symbol = b.symbol AND l.d = b.d
 WHERE b.d >= '2025-04-01' AND b.o1 > 0 AND b.c5 > 0 AND abs(b.o1/b.close-1) < 0.31 AND abs(b.c5/b.close-1) < 1
   AND b.close * b.volume >= 1e9 AND cb.close > 0
  `
];

for (const statement of setup) await client.query(statement);

async function show(title, sql) {
  const { rows } = await client.query(sql);

  console.log(`
== ${title}`);
  console.table(rows);
}

const outcomes = `count(*)::int n,
  round((percentile_cont(.5) within group (order by ex1))::numeric, 2) m1, round(avg((ex1 > 0)::int) * 100) b1,
  round((percentile_cont(.5) within group (order by ex5))::numeric, 2) m5, round(avg((ex5 > 0)::int) * 100) b5,
  round(avg(jump15::int) * 100, 1) j15`;

await show("공매도 비중, 20일 평균 대비", `
  SELECT sz, CASE WHEN sr IS NULL THEN '0 데이터X' WHEN sr = 0 AND coalesce(sr20, 0) = 0 THEN '1 평소도 0'
              WHEN sr = 0 THEN '2 오늘 0' WHEN sr20 = 0 THEN '6 0에서 생김' WHEN sr / sr20 < 0.5 THEN '3 절반↓'
              WHEN sr / sr20 < 2 THEN '4 평소' WHEN sr / sr20 < 4 THEN '5 2~4배' ELSE '7 4배↑' END k, ${outcomes}
    FROM x WHERE n20 = 20 OR sr IS NULL GROUP BY 1, 2 ORDER BY 1, 2`);

await show("대차잔고 5일 변화", `
  SELECT sz, CASE WHEN bal IS NULL THEN '0 데이터X' WHEN bal = 0 AND coalesce(bal5, 0) = 0 THEN '1 잔고0'
              WHEN bal5 IS NULL OR bal5 = 0 THEN '7 새로 생김' WHEN bal / bal5 - 1 < -0.3 THEN '2 30%↓'
              WHEN bal / bal5 - 1 < -0.1 THEN '3 10~30%↓' WHEN bal / bal5 - 1 <= 0.1 THEN '4 ±10%'
              WHEN bal / bal5 - 1 <= 0.3 THEN '5 10~30%↑' ELSE '6 30%↑' END k, ${outcomes}
    FROM x GROUP BY 1, 2 ORDER BY 1, 2`);

await show("대차잔고가 거래량 며칠치", `
  SELECT sz, CASE WHEN bal IS NULL OR bal = 0 THEN '0 없음' WHEN bal / nullif(v20, 0) < 0.5 THEN '1 반나절↓'
              WHEN bal / v20 < 2 THEN '2 0.5~2일' WHEN bal / v20 < 5 THEN '3 2~5일' ELSE '4 5일↑' END k, ${outcomes}
    FROM x GROUP BY 1, 2 ORDER BY 1, 2`);

await show("소형 보통주, 대차 있음/없음 달별 5일 평균 초과", `
  SELECT date_trunc('month', d)::date::text m,
         round(avg(ex5) FILTER (WHERE coalesce(bal, 0) = 0)::numeric, 2) none,
         round(avg(ex5) FILTER (WHERE bal > 0)::numeric, 2) lent
    FROM x WHERE sz = '3소형' AND symbol ~ '0$'
     AND symbol IN (SELECT symbol FROM kr_stock_lending GROUP BY symbol HAVING max(balance_qty) > 0)
   GROUP BY 1 ORDER BY 1`);

client.release();
process.exit(0);
