import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 외국인·기관이 산 종목은 다음날 갭상승하는가.
 *
 *   node scripts/measure-investor-flow.mjs
 *
 * 사용자 질문: "외국인 순매수 상위 이거 종가배팅인가?" 다른 것이지만, 그 목록이
 * 하룻밤에 값이 있는지는 별개로 답할 수 있습니다.
 *
 * [[close-bet-findings]]에 기관 3일연속이 +0.113%p로 미미하다고만 적혀 있고
 * 외국인 단일일은 재지 않았습니다.
 *
 * 구간은 종가배팅과 같습니다 -- 종가 매수, 익일 시가 매도, **그날 밤 시장 평균
 * 갭을 뺀 초과분**. 밤이 갭의 대부분을 정하므로 절대값을 재면 밤을 재게 됩니다.
 */

const config = readConfig();

const { rows } = await query(config, `
  WITH bars AS (
    SELECT symbol, session_date, close,
           lead(open) OVER (PARTITION BY symbol ORDER BY session_date) AS next_open,
           close * volume AS turnover
      FROM kr_daily_bars
  ),
  nights AS (
    SELECT session_date, avg((next_open / close - 1) * 100) AS market_gap
      FROM bars WHERE close > 0 AND next_open IS NOT NULL
     GROUP BY session_date HAVING count(*) >= 50
  ),
  joined AS (
    SELECT f.session_date, f.symbol,
           f.foreign_amount, f.institution_amount,
           (b.next_open / b.close - 1) * 100 - n.market_gap AS excess,
           row_number() OVER (PARTITION BY f.session_date ORDER BY f.foreign_amount DESC) AS foreign_rank,
           row_number() OVER (PARTITION BY f.session_date ORDER BY f.institution_amount DESC) AS inst_rank,
           count(*) OVER (PARTITION BY f.session_date) AS day_size
      FROM kr_investor_flow f
      JOIN bars b ON b.symbol = f.symbol AND b.session_date = f.session_date
      JOIN nights n ON n.session_date = f.session_date
     WHERE b.close > 0 AND b.next_open IS NOT NULL
       AND b.turnover >= 1000000000
       AND f.foreign_amount IS NOT NULL AND f.institution_amount IS NOT NULL
  )
  SELECT session_date::text AS d, symbol, excess, foreign_rank, inst_rank, day_size,
         foreign_amount, institution_amount
    FROM joined
`);

const num = (v) => Number(v);
const days = new Set(rows.map((r) => r.d)).size;
const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

function report(label, list) {
  if (list.length < 30) return console.log(`  ${label.padEnd(26)} ${list.length}건 — 표본 부족`);

  const xs = list.map((r) => num(r.excess));

  console.log(`  ${label.padEnd(26)} ${String(list.length).padStart(6)}건 · 초과 ${mean(xs) >= 0 ? "+" : ""}${mean(xs).toFixed(3)}%p · 상회 ${Math.round(xs.filter((x) => x > 0).length / xs.length * 100)}%`);
}

console.log(`\n표본 ${rows.length.toLocaleString("ko-KR")} 종목-밤 · ${days}개 밤 · 거래대금 10억↑`);
console.log(`종가 매수·익일 시가 매도, 그날 밤 시장 평균 갭을 뺀 초과분\n`);

console.log("=== 외국인 순매수 순위 ===\n");
report("전체", rows);
[[1, 5], [1, 10], [11, 30], [31, 100]].forEach(([from, to]) =>
  report(`${from}~${to}위`, rows.filter((r) => num(r.foreign_rank) >= from && num(r.foreign_rank) <= to)));
report("순매도 (하위 10)", rows.filter((r) => num(r.day_size) - num(r.foreign_rank) < 10));

console.log("\n=== 기관 순매수 순위 ===\n");
[[1, 5], [1, 10], [11, 30]].forEach(([from, to]) =>
  report(`${from}~${to}위`, rows.filter((r) => num(r.inst_rank) >= from && num(r.inst_rank) <= to)));

console.log("\n=== 둘 다 사면 ===\n");
report("외국인·기관 동시 10위내", rows.filter((r) => num(r.foreign_rank) <= 10 && num(r.inst_rank) <= 10));
report("외국인 10위내·기관 순매도", rows.filter((r) => num(r.foreign_rank) <= 10 && num(r.institution_amount) < 0));
report("기관 10위내·외국인 순매도", rows.filter((r) => num(r.inst_rank) <= 10 && num(r.foreign_amount) < 0));

process.exit(0);
