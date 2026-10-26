import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 이틀 강하게 산 외국인이 사흘째 식으면 끝났다는 뜻인가.
 *
 *   node scripts/measure-flow-fade.mjs
 *
 * 계기: 2026-10-26 삼성E&A. 외국인 확정 순매수가 10/22 +1,268억, 10/23 +1,750억
 * 뒤 10/26 +61억으로 식었고, 사용자가 "재료 소멸 같다"고 봤습니다.
 *
 * 앞의 이틀 모두 외국인 순매수 100억 이상인 종목에서, 사흘째(D) 외국인 금액을
 * 전날 대비 비율로 나눕니다. 값은 D 종가에서 산 것으로 보고 다음날 시가·종가를
 * 그날 수급 표 전 종목 평균 대비 초과분으로 냅니다(`open > 0` 필수).
 * 금액 단위는 백만원이라 100억은 10000입니다.
 */

const config = readConfig();
const pct = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%p`;

const { rows } = await query(config, `
  WITH bars AS (
    SELECT symbol, session_date, close,
           lead(open) OVER w AS next_open,
           lead(close) OVER w AS next_close
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  flow AS (
    SELECT symbol, session_date, foreign_amount AS f0, institution_amount AS i0,
           lag(foreign_amount, 1) OVER w AS f1,
           lag(foreign_amount, 2) OVER w AS f2
      FROM kr_investor_flow
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  base AS (
    SELECT f.*, (b.next_open / b.close - 1) * 100 AS gap,
           (b.next_close / b.close - 1) * 100 AS next_day
      FROM flow f JOIN bars b USING (symbol, session_date)
     WHERE b.next_open > 0 AND b.close > 0 AND b.next_close > 0
  ),
  market AS (
    SELECT session_date, avg(gap) AS m_gap, avg(next_day) AS m_next
      FROM base GROUP BY session_date
  )
  SELECT b.*, m.m_gap, m.m_next,
         CASE
           WHEN b.f0 <= 0 THEN '1 사흘째 순매도'
           WHEN b.f0 < b.f1 * 0.2 THEN '2 20% 미만으로 식음'
           WHEN b.f0 < b.f1 * 0.6 THEN '3 20~60%'
           ELSE '4 60% 이상 유지'
         END AS bucket
    FROM base b JOIN market m USING (session_date)
   WHERE b.f1 >= 10000 AND b.f2 >= 10000
`);

const groups = [...new Set(rows.map((r) => r.bucket))].sort();
console.log(`표본 ${rows.length}건 (외국인 이틀 연속 100억+ 순매수 다음날)`);
for (const g of groups) {
  const list = rows.filter((r) => r.bucket === g);
  const gaps = list.map((r) => Number(r.gap) - Number(r.m_gap)).sort((a, b) => a - b);
  const nexts = list.map((r) => Number(r.next_day) - Number(r.m_next)).sort((a, b) => a - b);
  const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const days = new Set(list.map((r) => String(r.session_date))).size;
  console.log(`${g.padEnd(14)} n=${String(list.length).padStart(3)} 장=${String(days).padStart(2)}  시가 평균 ${pct(mean(gaps))} 중앙 ${pct(gaps[Math.floor(gaps.length / 2)])} 상회 ${((gaps.filter((v) => v > 0).length / gaps.length) * 100).toFixed(0)}%  익일종가 평균 ${pct(mean(nexts))} 중앙 ${pct(nexts[Math.floor(nexts.length / 2)])}`);
}
