import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 전일 수급이 종가배팅에 값이 있는가.
 *
 *   node scripts/measure-close-bet-flow.mjs
 *
 * 계기: 2026-09-02 엑시콘이 기관 이틀 연속 순매수(36억 → 61억)였고, 사용자가
 * "기관이 산다는 건 뭔가 있다는 것"이라고 했습니다. 옛 측정은 기관 3일 연속을
 * 9,770밤에서 +0.113%p로 재고 넘어갔는데, 그건 사용자가 말한 것과 다릅니다 --
 * 2일 연속도, 금액 크기도, **외국인은 파는데 기관만 사는 엇갈림**도 안 쟀습니다.
 *
 * **전일까지만 씁니다.** `kr_investor_flow`는 16:10 정산이라 당일치는 15:20에
 * 존재하지 않습니다. 당일 수급으로 재면 못 봤던 정보로 판단을 채점하게 됩니다.
 *
 * **모집단을 후보로 좁히지 않습니다.** 수급 표가 2026-07-07부터라 40개 장뿐이고,
 * 그 안의 운영 후보는 쉰 건이 안 됩니다. 그래서 "그날 오른 종목" 전체에서 먼저
 * 재고, 후보 부분집합은 참고로만 붙입니다. 좁은 표본에서 나온 큰 숫자를 근거로
 * 조건을 바꾸면 그게 과적합입니다.
 *
 * 값은 전부 **그날 밤 시장 평균 갭 대비 초과분**입니다.
 */

const config = readConfig();
const pct = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(3)}%p`;

const { rows } = await query(config, `
  WITH bars AS (
    SELECT symbol, session_date, close, volume,
           lag(close) OVER w AS prev_close,
           lead(open) OVER w AS next_open
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  /*
   * 시장 평균 갭을 **표본과 같은 모집단**에서 냅니다. 전 종목 4,300개로 잡으면
   * 거래 없는 종목이 평균을 끌어내려 유동성 있는 종목은 무엇이든 시장을 이기는
   * 것처럼 보입니다 -- measure-news-lead.mjs에서 "기사 없음"이 +1.383%p로 나온
   * 것이 그것이었고, 고치니 -0.395%p로 뒤집혔습니다.
   */
  market AS (
    SELECT session_date, avg(open / nullif(prev, 0) - 1) * 100 AS gap
      FROM (SELECT symbol, session_date, open, close, volume,
                   lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev
              FROM kr_daily_bars) t
     WHERE prev > 0 AND close * volume >= 500000000
     GROUP BY session_date HAVING count(*) >= 50
  ),
  /*
   * 다음 장의 시장 갭을 행마다 상관 서브쿼리로 뽑으면 17만 행에서 끝나지 않습니다.
   * 장 목록에 순번을 매겨 한 번의 조인으로 붙입니다.
   */
  days AS (
    SELECT session_date, gap, row_number() OVER (ORDER BY session_date) AS rn FROM market
  )
  SELECT b.symbol, b.session_date::text AS d,
         (b.close / b.prev_close - 1) * 100 AS day_move,
         b.close * b.volume AS turnover,
         (b.next_open / b.close - 1) * 100 - nxt.gap AS excess
    FROM bars b
    JOIN days cur ON cur.session_date = b.session_date
    JOIN days nxt ON nxt.rn = cur.rn + 1
   WHERE b.prev_close > 0 AND b.close > 0 AND b.next_open > 0
     AND b.session_date >= '2026-07-07'
     AND b.close * b.volume >= 500000000
`);

/*
 * 수급은 통째로 받아 여기서 맞춥니다. 밤마다 LATERAL로 두 행씩 뽑으면 1만8천 번
 * 도느라 몇 시간이 지나도 안 끝났습니다.
 */
const { rows: flowRows } = await query(config, `
  SELECT symbol, session_date::text AS d, institution_amount, foreign_amount
    FROM kr_investor_flow ORDER BY symbol, session_date
`);

const flowOf = new Map();

for (const row of flowRows) {
  const list = flowOf.get(row.symbol) ?? [];

  list.push(row);
  flowOf.set(row.symbol, list);
}

/** 그날 **이전** 두 장. 당일치는 16:10 정산이라 15:20에 없습니다. */
function priorFlow(symbol, day) {
  const list = (flowOf.get(symbol) ?? []).filter((row) => row.d < day);

  return list.slice(-2).reverse();
}

const num = (value) => (value === null || value === undefined ? null : Number(value));
const all = rows.map((row) => {
  const prior = priorFlow(row.symbol, row.d);

  return {
    d: row.d,
    excess: num(row.excess),
    fore1: prior[0] ? num(prior[0].foreign_amount) : null,
    fore2: prior[1] ? num(prior[1].foreign_amount) : null,
    inst1: prior[0] ? num(prior[0].institution_amount) : null,
    inst2: prior[1] ? num(prior[1].institution_amount) : null,
    move: num(row.day_move),
    symbol: row.symbol,
    turnover: num(row.turnover)
  };
}).filter((row) => row.inst1 !== null && row.fore1 !== null);

function report(label, list, floor = 30) {
  const xs = list.map((row) => row.excess).filter((x) => Number.isFinite(x));

  if (xs.length < floor) {
    console.log(`  ${label.padEnd(30)} ${String(xs.length).padStart(6)}건  표본 부족`);

    return;
  }

  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const beat = xs.filter((x) => x > 0).length / xs.length * 100;

  console.log(`  ${label.padEnd(30)} ${String(xs.length).padStart(6)}건  초과 ${pct(mean).padStart(9)}  상회 ${beat.toFixed(0).padStart(3)}%`);
}

/*
 * 그냥 오른 종목이 아니라 **살 만한 종목**에서 재야 합니다. 전 종목에서 재면
 * 거래가 거의 없는 종목이 표본을 채우고, 거기서 나온 수급 신호는 살 수 없는
 * 종목의 것입니다.
 */
const active = all.filter((row) => row.turnover >= 1_000_000_000 && row.move >= 5);

console.log(`\n전일 수급과 종가배팅 · ${all.length.toLocaleString("ko-KR")} 종목-밤 · 수급표 2026-07-07부터`);
console.log("값은 그날 밤 시장 평균 갭 대비 초과분. 수급은 전일까지만 씁니다(16:10 정산).\n");

console.log(`[기준] 거래대금 10억↑ · 당일 5%↑ · ${active.length}건`);
report("전체", active);

console.log("\n[1] 전일 기관");
report("  기관 순매수 (+)", active.filter((row) => row.inst1 > 0));
report("  기관 순매도 (−)", active.filter((row) => row.inst1 < 0));

console.log("\n[2] 이틀 연속 — 사용자가 말한 자리");
report("  기관 2일 연속 순매수", active.filter((row) => row.inst1 > 0 && row.inst2 > 0));
report("  기관 2일 연속 순매도", active.filter((row) => row.inst1 < 0 && row.inst2 < 0));

console.log("\n[3] 엇갈림 — 외국인은 파는데 기관만 사는가");
report("  기관 + · 외국인 −", active.filter((row) => row.inst1 > 0 && row.fore1 < 0));
report("  기관 + · 외국인 +", active.filter((row) => row.inst1 > 0 && row.fore1 > 0));
report("  기관 − · 외국인 +", active.filter((row) => row.inst1 < 0 && row.fore1 > 0));
report("  기관 − · 외국인 −", active.filter((row) => row.inst1 < 0 && row.fore1 < 0));

console.log("\n[4] 전일 외국인 단독");
report("  외국인 순매수 (+)", active.filter((row) => row.fore1 > 0));
report("  외국인 순매도 (−)", active.filter((row) => row.fore1 < 0));

/*
 * 금액은 백만원 단위로 들어옵니다. 절대 금액으로 자르면 대형주만 큰 구간에
 * 들어가므로, 그날 거래대금 대비 비율로도 봅니다.
 */
console.log("\n[5] 기관 순매수 크기 (그날 거래대금 대비)");

const share = (row) => (row.turnover > 0 ? row.inst1 * 1_000_000 / row.turnover * 100 : null);

for (const [low, high, label] of [
  [0, 1, "0~1%"], [1, 3, "1~3%"], [3, 10, "3~10%"], [10, 1000, "10%↑"]
]) {
  report(`  ${label}`, active.filter((row) => {
    const value = share(row);

    return value !== null && value >= low && value < high;
  }));
}

/*
 * 운영 후보 부분집합. 표본이 얇아 판정이 아니라 확인용입니다 -- 넓은 모집단에서
 * 나온 방향이 후보에서도 같은지만 봅니다.
 */
const { rows: picks } = await query(config, `
  SELECT symbol, session_date::text AS d FROM kr_signal_outcomes
   WHERE kind = 'close_bet' AND session_date >= '2026-07-07'
`);
const pickKeys = new Set(picks.map((row) => `${row.d}|${row.symbol}`));
const onPicks = all.filter((row) => pickKeys.has(`${row.d}|${row.symbol}`));

console.log(`\n[참고] 운영 후보 부분집합 · ${onPicks.length}건 — 판정에 쓰지 마세요`);
report("전체", onPicks, 1);
report("  기관 전일 순매수", onPicks.filter((row) => row.inst1 > 0), 1);
report("  기관 2일 연속", onPicks.filter((row) => row.inst1 > 0 && row.inst2 > 0), 1);
report("  기관 + · 외국인 −", onPicks.filter((row) => row.inst1 > 0 && row.fore1 < 0), 1);

console.log("");
process.exit(0);
