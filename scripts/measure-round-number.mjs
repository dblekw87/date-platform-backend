import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 피겨라운드(딱 떨어지는 가격)에서 막힌 종목이 다시 뚫는가.
 *
 *   node scripts/measure-round-number.mjs
 *
 * 2026-10-22 사용자 가설입니다. 삼성E&A가 56,000원에 두 번 막혔고, "못 뚫겠다
 * 싶으면 아래로 내려 다시 매집했다가 돌파한다"고 했습니다. 가설이 맞으려면
 * 둥근 가격이 아무 가격보다 나아야 하므로, 같은 간격을 0.37단위 밀어 둔
 * 어중간한 가격을 대조군으로 씁니다.
 *
 * 막힌 날: 20일 동안 그 가격 1% 안에 간 적이 없고, 고가가 가격의 −1%~+0.3%,
 * 종가가 고가보다 3% 넘게 밀림. 단위 S = 10^(자릿수−1)이라 5만원대면 1,000원,
 * 그 열 배수·다섯 배수는 따로 칸을 나눕니다. 대금 10억+, 주가 1,000원+.
 *
 * 첫 결과(2.7만건): 10일 안 종가 돌파 41/36/38% 대 대조군 38%, 단조가 아니라
 * 피겨라운드 효과 없음. 막힌 날 자체가 10일 초과 중앙 약 −3%p.
 */

const config = readConfig();

const { rows } = await query(config, `
  WITH bb AS (
    SELECT symbol, session_date, high, low, close, volume,
           max(high) OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS ph20,
           count(*) OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS n20,
           max(close) OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 1 FOLLOWING AND 10 FOLLOWING) AS maxc10,
           min(low) OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 1 FOLLOWING AND 5 FOLLOWING) AS minl5,
           lead(close, 10) OVER (PARTITION BY symbol ORDER BY session_date) AS c10,
           lead(session_date, 10) OVER (PARTITION BY symbol ORDER BY session_date) AS d10
      FROM kr_daily_bars WHERE close > 0 AND open > 0 AND high > 0
  ), mkt AS (
    -- Equal-weight index from close-to-close returns, dropping moves past the ±30% limit.
    SELECT session_date, exp(sum(ln(1 + r)) OVER (ORDER BY session_date)) AS idx FROM (
      SELECT session_date, avg(r) AS r FROM (
        SELECT session_date, close / lag(close) OVER (PARTITION BY symbol ORDER BY session_date) - 1 AS r FROM bb
      ) z WHERE r BETWEEN -0.31 AND 0.31 GROUP BY 1
    ) y
  ), ev AS (
    SELECT b.*, k.kind, k.lvl, st.s
      FROM bb b
      CROSS JOIN LATERAL (SELECT power(10, floor(log(b.high::numeric)) - 1) AS s) st
      CROSS JOIN LATERAL (VALUES
        ('round', ceil(b.high * 0.997 / st.s) * st.s),
        ('ctrl', ceil((b.high * 0.997 - 0.37 * st.s) / st.s) * st.s + 0.37 * st.s)) k(kind, lvl)
     WHERE b.n20 = 20 AND b.close >= 1000 AND b.close * b.volume >= 1e9 AND b.c10 IS NOT NULL
       AND b.high >= 0.99 * k.lvl AND b.high <= 1.003 * k.lvl
       AND b.close <= b.high * 0.97
       AND b.ph20 < 0.99 * k.lvl
  ), x AS (
    SELECT CASE WHEN kind = 'ctrl' THEN 'ctrl'
                WHEN mod(lvl, 10 * s) = 0 THEN 'round x10'
                WHEN mod(lvl, 5 * s) = 0 THEN 'round x5'
                ELSE 'round x1' END AS tier,
           maxc10 >= lvl * 1.005 AS broke,
           minl5 < close * 0.97 AND maxc10 >= lvl * 1.005 AS dip_broke,
           ((c10 / close - 1) - (m10.idx / m0.idx - 1)) * 100 AS ex
      FROM ev
      JOIN mkt m0 ON m0.session_date = ev.session_date
      JOIN mkt m10 ON m10.session_date = ev.d10
  )
  SELECT tier, count(*)::int AS n,
         avg(broke::int)::float8 AS broke,
         avg(dip_broke::int)::float8 AS dip_broke,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY ex))::float8 AS median,
         avg((ex > 0)::int)::float8 AS beat
    FROM x GROUP BY 1 ORDER BY 1`);

console.log("tier      |     n | broke 10d | dip→broke | ex10 median | beat");

for (const row of rows) {
  console.log([
    row.tier.padEnd(9),
    String(row.n).padStart(5),
    `${Math.round(row.broke * 100)}%`.padStart(9),
    `${Math.round(row.dip_broke * 100)}%`.padStart(9),
    row.median.toFixed(2).padStart(11),
    `${Math.round(row.beat * 100)}%`.padStart(4)
  ].join(" | "));
}

process.exit(0);
