import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 외국인이 장 막판에 털면 다음날 시가가 약한가.
 *
 *   node scripts/measure-foreign-late-exit.mjs
 *
 * 계기: 2026-10-26 삼성E&A. 장중 외국인 추정이 14:30 무렵 +55.8만 주였는데
 * 확정치는 +10.4만 주였습니다 -- 마지막 한 시간에 45만 주를 판 셈입니다.
 * 사용자가 "외인들도 막판에 다 팔았네, 재료 소멸 같다"고 봤습니다.
 *
 * 비교는 **마지막 추정(bucket 5, 14:30 무렵) 대비 확정치(16:10 정산)** 입니다.
 * 확정치는 장이 끝난 뒤에야 나오므로 이 신호는 진입이 아니라 **다음날 아침
 * 매도 판단**에 쓰는 것입니다.
 *
 * 마지막 추정이 의미 있게 산 경우(추정 금액 10억 이상)만 봅니다. 값은 그날
 * 추정 표에 있던 종목 전체의 다음날 시가 갭 평균 대비 초과분입니다
 * (`open > 0` 필수 -- measurement-pitfalls).
 */

const config = readConfig();
const pct = (value) => (value === null ? "-" : `${value >= 0 ? "+" : ""}${Number(value).toFixed(2)}%p`);

const { rows } = await query(config, `
  WITH bars AS (
    SELECT symbol, session_date, close,
           lag(close) OVER w AS prev_close,
           lead(open) OVER w AS next_open,
           lead(close) OVER w AS next_close
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  est AS (
    SELECT symbol, session_date, foreign_qty AS est_qty
      FROM kr_foreign_estimate
     WHERE bucket = 5
  ),
  base AS (
    SELECT e.symbol, e.session_date, e.est_qty, f.foreign_qty AS final_qty,
           b.close, b.prev_close, b.next_open, b.next_close,
           (b.next_open / b.close - 1) * 100 AS gap,
           (b.next_close / b.close - 1) * 100 AS next_day,
           (b.close / b.prev_close - 1) * 100 AS day_change
      FROM est e
      JOIN kr_investor_flow f USING (symbol, session_date)
      JOIN bars b USING (symbol, session_date)
     WHERE b.next_open > 0 AND b.close > 0 AND b.prev_close > 0
  ),
  market AS (
    SELECT session_date, avg(gap) AS m_gap, avg(next_day) AS m_next
      FROM base GROUP BY session_date
  )
  SELECT b.*, m.m_gap, m.m_next,
         CASE
           WHEN b.final_qty <= 0 THEN '1 확정 순매도로 뒤집힘'
           WHEN b.final_qty < b.est_qty * 0.5 THEN '2 절반 넘게 털림'
           WHEN b.final_qty < b.est_qty THEN '3 조금 털림'
           ELSE '4 막판에 더 삼'
         END AS bucket
    FROM base b JOIN market m USING (session_date)
   WHERE b.est_qty * b.close >= 1e9
`);

function summarize(list) {
  const gaps = list.map((r) => Number(r.gap) - Number(r.m_gap)).sort((a, b) => a - b);
  const nexts = list.map((r) => Number(r.next_day) - Number(r.m_next));
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const mean = gaps.length ? gaps.reduce((s, v) => s + v, 0) / gaps.length : null;
  const beat = gaps.length ? (gaps.filter((v) => v > 0).length / gaps.length) * 100 : null;
  const nextMean = nexts.length ? nexts.reduce((s, v) => s + v, 0) / nexts.length : null;
  const days = new Set(list.map((r) => String(r.session_date))).size;

  return { beat, days, mean, median, n: list.length, nextMean };
}

function print(title, list) {
  console.log(`\n## ${title}`);
  const groups = [...new Set(list.map((r) => r.bucket))].sort();
  for (const g of groups) {
    const s = summarize(list.filter((r) => r.bucket === g));
    console.log(`${g.padEnd(16)} n=${String(s.n).padStart(4)} 장=${String(s.days).padStart(2)}  시가 평균 ${pct(s.mean)} 중앙 ${pct(s.median)} 상회 ${s.beat?.toFixed(0)}%  익일종가 평균 ${pct(s.nextMean)}`);
  }
}

console.log(`표본 ${rows.length}건 (마지막 추정 매수 10억 이상)`);
print("전체", rows);
print("그날 +2% 이상 오른 종목", rows.filter((r) => Number(r.day_change) >= 2));
print("그날 −2~+2% (횡보)", rows.filter((r) => Math.abs(Number(r.day_change)) < 2));
print("대형(종가×추정 50억 이상)", rows.filter((r) => Number(r.est_qty) * Number(r.close) >= 5e9));
