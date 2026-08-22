import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 짝꿍매매 실측 — 이번에는 실제 매매법대로.
 *
 * 앞선 measure-pair-trade.mjs는 다른 것을 쟀습니다. 거기서 1등주는 그 테마에서
 * **거래대금**이 가장 큰 종목이었고 조건은 5% 이상 상승이었으며, 짝꿍은 "덜 오른
 * 종목"이었습니다. 실제 매매는 그렇지 않습니다.
 *
 *   1등주는 그 테마에서 **상승률**이 가장 높은 종목이고,
 *   그 종목이 **상한가에 잠겼을 때** 2등주를 사는 것이며,
 *   2등주는 뒤처진 종목이 아니라 **상승률 2위**입니다.
 *
 * 메커니즘이 상한가에 있습니다. 상한가는 더 높은 가격에 거래가 안 되는 상태라,
 * 그 종목을 사려던 수요가 갈 곳을 잃고 같은 테마의 다음 종목으로 넘칩니다. 원전
 * 테마에서 한전이 상한가면 우리기술이 오르려는 습성이 그것입니다.
 *
 * 그래서 미국에서는 성립하지 않았습니다 -- 가격제한폭이 없으면 수요가 넘칠 이유가
 * 없고 그 종목 안에서 다 소화됩니다. [[us-pair-trade-verdict]]에 적힌 그대로입니다.
 *
 * 국내 가격제한폭은 ±30%이므로 상한가는 +29.x%입니다. "근처"까지 같이 재서 어디서
 * 효과가 끊기는지 봅니다.
 *
 * 재는 값은 그날 시장 평균 대비 초과분입니다.
 *
 *   node scripts/measure-limit-pair.mjs
 */

const config = readConfig();

const { rows } = await query(config, `
  WITH members AS (
    SELECT DISTINCT symbol, theme_name
      FROM kr_theme_members
     WHERE theme_name !~ '(밸류업|기업인수목적|신규상장|리츠\\(REITs\\)|국내 상장 중국기업|지주사)'
  ),
  bars AS (
    SELECT symbol, session_date, close, volume, close * volume AS turnover,
           lag(close) OVER w AS prev_close,
           lead(close) OVER w AS next_close,
           lead(open) OVER w AS next_open
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  moves AS (
    SELECT symbol, session_date, turnover,
           (close / prev_close - 1) * 100 AS day_move,
           (next_open / close - 1) * 100 AS gap,
           (next_close / close - 1) * 100 AS next_day
      FROM bars
     WHERE prev_close > 0 AND close > 0 AND next_close IS NOT NULL
       AND close * volume >= 500000000
  ),
  nights AS (
    SELECT session_date, avg(gap) AS market_gap, avg(next_day) AS market_next
      FROM moves GROUP BY session_date HAVING count(*) >= 50
  ),
  -- 상승률 순위입니다. 거래대금이 아닙니다.
  ranked AS (
    SELECT m.*, t.theme_name,
           row_number() OVER (PARTITION BY t.theme_name, m.session_date
                              ORDER BY m.day_move DESC) AS move_rank
      FROM moves m
      JOIN members t ON t.symbol = m.symbol
  )
  SELECT l.session_date::text AS d, l.theme_name,
         l.symbol AS leader, l.day_move AS leader_move,
         l.gap - n.market_gap AS leader_gap_excess,
         s.symbol AS second, s.day_move AS second_move, s.turnover AS second_turnover,
         s.gap - n.market_gap AS second_gap_excess,
         s.next_day - n.market_next AS second_next_excess,
         third.symbol AS third, third.day_move AS third_move,
         third.gap - n.market_gap AS third_gap_excess
    FROM ranked l
    JOIN ranked s ON s.theme_name = l.theme_name AND s.session_date = l.session_date AND s.move_rank = 2
    LEFT JOIN ranked third ON third.theme_name = l.theme_name AND third.session_date = l.session_date AND third.move_rank = 3
    JOIN nights n ON n.session_date = l.session_date
   WHERE l.move_rank = 1
`);

const num = (v) => (v === null ? null : Number(v));
const nights = new Set(rows.map((r) => r.d)).size;
const report = (label, list, key = "second_gap_excess") => {
  const xs = list.map((r) => num(r[key])).filter((x) => x !== null);

  if (xs.length < 40) {
    console.log(`  ${label.padEnd(34)} ${String(xs.length).padStart(5)}건 · 표본 부족`);

    return;
  }

  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const beat = xs.filter((x) => x > 0).length;

  console.log(`  ${label.padEnd(34)} ${String(xs.length).padStart(5)}건 · 상회 ${String(Math.round((beat / xs.length) * 100)).padStart(3)}% · 초과 ${mean >= 0 ? "+" : ""}${mean.toFixed(3)}%p`);
};

console.log(`테마-일 ${rows.length}건 · 밤 ${nights}개 · 상승률 1위/2위 짝`);
console.log(`기간 ${rows.reduce((a, r) => (r.d < a ? r.d : a), "9999")} ~ ${rows.reduce((a, r) => (r.d > a ? r.d : a), "0")}`);
console.log("\n기준선은 그날 시장 평균 갭. 2등주를 종가에 사서 익일 시가에 판 값입니다.\n");

console.log("[1] 1등주가 얼마나 올랐을 때 2등주가 따라오는가");
for (const [label, lo, hi] of [
  ["1등주 5~10%", 5, 10], ["1등주 10~15%", 10, 15], ["1등주 15~20%", 15, 20],
  ["1등주 20~25%", 20, 25], ["1등주 25~29%", 25, 29], ["1등주 29% 이상 (상한가)", 29, 100]
]) {
  report(label, rows.filter((r) => num(r.leader_move) >= lo && num(r.leader_move) < hi));
}

console.log("\n[2] 상한가일 때 — 2등주 vs 3등주 vs 1등주 자신");
const limit = rows.filter((r) => num(r.leader_move) >= 29);

report("2등주", limit);
report("3등주", limit, "third_gap_excess");
report("1등주 자신 (상한가에 산다면)", limit, "leader_gap_excess");
report("2등주 · 하루 보유", limit, "second_next_excess");

console.log("\n[3] 상한가 + 2등주 조건을 더하면");
report("2등주도 10% 이상 올랐을 때", limit.filter((r) => num(r.second_move) >= 10));
report("2등주 5~15% (너무 안 갔거나 간 것 제외)", limit.filter((r) => num(r.second_move) >= 5 && num(r.second_move) < 15));
report("2등주 5% 미만 (거의 안 움직임)", limit.filter((r) => num(r.second_move) < 5));
report("2등주 거래대금 50억 이상", limit.filter((r) => num(r.second_turnover) >= 5e9));

console.log("\n[4] 비교 — 상한가가 아니어도 되는가");
report("1등주 20% 이상", rows.filter((r) => num(r.leader_move) >= 20));
report("1등주 29% 이상 (상한가)", limit);

/*
 * 둘 다 달리는 자리.
 *
 * 실제 매매는 1등주가 상한가에 잠긴 뒤가 아니라 그 전, 1등주 23%에 2등주 20% 같은
 * 구간에서 2등주를 잡는 것입니다. 그러면 1등주의 높이만이 아니라 둘의 조합이
 * 조건이므로 격자로 봐야 합니다.
 */
console.log("\n[5] 1등주 × 2등주 격자 — 칸은 2등주 종가매수·익일시가매도 초과분");
console.log("     표본 40건 미만은 -\n");

const leaderBands = [[10, 15], [15, 20], [20, 25], [25, 29], [29, 100]];
const secondBands = [[0, 5], [5, 10], [10, 15], [15, 20], [20, 100]];
const band = ([lo, hi]) => `${lo}~${hi === 100 ? "" : hi}%`;
const cell = (list) => {
  const xs = list.map((r) => num(r.second_gap_excess)).filter((x) => x !== null);

  if (xs.length < 40) return "      -";

  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;

  return `${mean >= 0 ? "+" : ""}${mean.toFixed(2)}%p`.padStart(7);
};

console.log(`  1등주 \\ 2등주  ${secondBands.map((b) => band(b).padStart(7)).join(" ")}`);

for (const [low, high] of leaderBands) {
  const inLeader = rows.filter((r) => num(r.leader_move) >= low && num(r.leader_move) < high);

  console.log(`  ${band([low, high]).padEnd(12)}  ${secondBands.map(([slow, shigh]) =>
    cell(inLeader.filter((r) => num(r.second_move) >= slow && num(r.second_move) < shigh))).join(" ")}`);
}

console.log("\n[6] 둘 사이 간격 — 둘 다 15% 이상 달릴 때만");

const bothRunning = rows.filter((r) => num(r.leader_move) >= 15 && num(r.second_move) >= 15);

report("전체 (둘 다 15%↑)", bothRunning);

for (const [low, high] of [[0, 2], [2, 5], [5, 10], [10, 100]]) {
  report(`  간격 ${band([low, high])}p`, bothRunning.filter((r) => {
    const gap = num(r.leader_move) - num(r.second_move);

    return gap >= low && gap < high;
  }));
}

console.log("\n[7] 실제로 몇 번이나 나오는 자리인가");

for (const [label, test] of [
  ["1등주 20%↑ & 2등주 15%↑", (r) => num(r.leader_move) >= 20 && num(r.second_move) >= 15],
  ["1등주 20~29% & 2등주 15%↑", (r) => num(r.leader_move) >= 20 && num(r.leader_move) < 29 && num(r.second_move) >= 15],
  ["1등주 상한가 & 2등주 15%↑", (r) => num(r.leader_move) >= 29 && num(r.second_move) >= 15]
]) {
  const list = rows.filter(test);

  console.log(`  ${label} · ${list.length}건 · 하루 ${(list.length / nights).toFixed(2)}건`);
  report("    갭", list);
  report("    하루 보유", list, "second_next_excess");
}

process.exit(0);
