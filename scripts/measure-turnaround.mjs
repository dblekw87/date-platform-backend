import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 마이너스에서 플러스로 돌아선 종목은 그 뒤에도 가는가.
 *
 *   node scripts/measure-turnaround.mjs
 *
 * 계기: 대우건설이 09:03에 −1.6%로 시작해 오후에 +11%가 됐습니다. 주도주 목록은
 * `changeRate > 0`을 요구하므로 도는 순간까지는 안 보입니다. 그 구간을 따로 잡을
 * 값이 있는지, 그리고 **거래량이 그 표시인지**가 질문입니다.
 *
 * ## 표본이 얇습니다
 *
 * 장중 현상이라 분봉이 필요한데 2026-08-18부터입니다. 확정된 장이 다섯입니다.
 * 통계가 아니라 관찰로 읽어야 합니다.
 *
 * ## 재는 법
 *
 * 한 종목이 그날 처음 음수에서 양수로 넘어간 표본을 '전환'으로 잡고, 거기서
 * 그날 마지막 표본까지의 등락률 변화를 봅니다. 시장이 같이 오른 것과 구분해야
 * 하므로 **같은 구간 전 종목 평균을 뺀 초과분**으로 답합니다.
 *
 * 대조군은 그 시각에 이미 양수였던 종목입니다. 전환이 특별한 자리인지 아니면
 * 그냥 오르는 종목이 오른 것인지를 가르는 것이 이 비교입니다.
 */

const config = readConfig();

const { rows } = await query(config, `
  WITH ticks AS (
    SELECT session_date::text AS d, symbol,
           date_trunc('minute', observed_at) AS t,
           max(change_rate) AS move,
           max(turnover) AS turnover,
           max(volume) AS volume,
           max(market_cap) AS cap
      FROM market_price_samples
     WHERE market = 'KR' AND source LIKE 'kis:krx%' AND change_rate IS NOT NULL
       AND session_date < (SELECT max(session_date) FROM market_price_samples WHERE market = 'KR')
     GROUP BY 1, 2, 3
  ),
  seq AS (
    SELECT ticks.*,
           lag(move) OVER w AS prev_move,
           last_value(move) OVER (PARTITION BY d, symbol ORDER BY t
                                  ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS close_move,
           row_number() OVER w AS rn
      FROM ticks
    WINDOW w AS (PARTITION BY d, symbol ORDER BY t)
  ),
  -- 그 시각의 시장. 전환 종목만 보면 시장이 같이 오른 날을 공으로 돌리게 됩니다.
  market AS (
    SELECT d, t, avg(move) AS now_move,
           avg(close_move) AS close_move
      FROM seq GROUP BY d, t HAVING count(*) >= 50
  ),
  turns AS (
    SELECT DISTINCT ON (s.d, s.symbol)
           s.d, s.symbol, s.t, s.move, s.close_move, s.turnover, s.volume, s.cap,
           (m.close_move - m.now_move) AS market_rest
      FROM seq s
      JOIN market m ON m.d = s.d AND m.t = s.t
     WHERE s.prev_move < 0 AND s.move > 0 AND s.rn > 1
     ORDER BY s.d, s.symbol, s.t
  ),
  -- 대조군: 같은 시각에 이미 양수였던 종목. 전환이 특별한지 가릅니다.
  holding AS (
    SELECT s.d, s.symbol, s.t, s.move, s.close_move,
           (m.close_move - m.now_move) AS market_rest
      FROM seq s
      JOIN market m ON m.d = s.d AND m.t = s.t
     WHERE s.prev_move > 0 AND s.move > 0
  )
  SELECT 'turn' AS kind, d, symbol, to_char(t + interval '9 hours','HH24:MI') AS kst,
         round(move::numeric, 2) AS at_move,
         round((close_move - move - market_rest)::numeric, 2) AS excess,
         round((volume / nullif(cap / nullif(turnover / nullif(volume, 0), 0), 0) * 100)::numeric, 2) AS turnover_ratio
    FROM turns
   UNION ALL
  SELECT 'hold', d, symbol, to_char(t + interval '9 hours','HH24:MI'),
         round(move::numeric, 2),
         round((close_move - move - market_rest)::numeric, 2),
         NULL
    FROM holding
`);

const num = (v) => Number(v);
const turns = rows.filter((r) => r.kind === "turn");
const holds = rows.filter((r) => r.kind === "hold");
const days = new Set(rows.map((r) => r.d)).size;
const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

function report(label, list) {
  if (list.length === 0) return console.log(`  ${label.padEnd(22)} 표본 없음`);

  const xs = list.map((r) => num(r.excess));

  console.log(`  ${label.padEnd(22)} ${String(list.length).padStart(6)}건 · 이후 초과 ${mean(xs) >= 0 ? "+" : ""}${mean(xs).toFixed(3)}%p · 상회 ${Math.round(xs.filter((x) => x > 0).length / xs.length * 100)}%`);
}

console.log(`\n확정된 장 ${days}개 · 전환 ${turns.length}건 · 대조군(이미 양수) ${holds.length}건`);
console.log(`값은 그 시각부터 종가까지, 같은 구간 시장 평균을 뺀 초과분입니다.\n`);

console.log("=== 전환이 특별한 자리인가 ===\n");
report("음→양 전환", turns);
report("이미 양수 (대조군)", holds);

console.log("\n=== 전환 시각별 ===\n");
[["09:00~10:00", "09"], ["10:00~11:00", "10"], ["11:00~12:00", "11"], ["12:00~13:00", "12"], ["13:00~", "13"]]
  .forEach(([label, hh]) => report(label, turns.filter((r) => r.kst.startsWith(hh))));

/**
 * 사용자 질문 -- 마이너스에서 도는 것은 폭발적인 거래량으로 봐야 하는가.
 *
 * 전환 시점까지 그 종목이 상장주식수의 몇 %를 돌렸는지로 나눕니다. 회전율은
 * 종가배팅에서 이미 값이 확인된 자입니다.
 */
console.log("\n=== 전환 시점의 회전율 ===\n");
[[0, 1], [1, 3], [3, 10], [10, Infinity]].forEach(([low, high]) => {
  report(`회전율 ${low}~${high === Infinity ? "" : high}%`,
    turns.filter((r) => r.turnover_ratio !== null && num(r.turnover_ratio) >= low && num(r.turnover_ratio) < high));
});

process.exit(0);
