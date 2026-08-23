import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 종가배팅에서 회전율이 거래량 배수를 대신할 수 있는가.
 *
 *   node scripts/measure-close-bet-turnover.mjs
 *
 * 지금 문턱은 규모별로 셋입니다 -- 대형 1.5배 / 중형 1.5배 / 소형 2배. 그렇게 쪼갠
 * 이유는 거래량 배수가 크기를 못 걸러내서입니다. 대형주는 거래량이 두 배 되는 일이
 * 원래 드물어서 같은 문턱을 걸면 통째로 빠집니다.
 *
 * 회전율(거래량 ÷ 상장주식수)은 애초에 크기로 나눈 값이라 그 문제가 없습니다.
 * **문턱 셋이 하나로 줄어드는가**가 이 스크립트의 질문입니다.
 *
 * 미국 급등 모델에서 회전율이 68배 판별을 냈지만 그것은 **10거래일 안에 급등하는가**를
 * 잰 숫자라 여기 오지 않습니다. 종가배팅은 하룻밤이므로 같은 구간 --
 * **종가 매수·익일 시가 매도, 그날 밤 시장 평균 대비 초과분** -- 으로 다시 잽니다.
 *
 * **주식수는 상수입니다.** `kr_daily_universe`가 하루치(2026-08-21)뿐이라 그날의
 * `market_cap / close_price`를 1.6년 내내 씁니다. 그 사이 액면분할이나 증자가 있었던
 * 종목은 회전율이 틀립니다 -- 규모 구간을 나눌 때 이미 같은 근사를 쓰고 있고,
 * 그만큼 할인해서 읽어야 합니다.
 */

const config = readConfig();
const started = Date.now();

const { rows } = await query(config, `
  WITH shares AS (
    SELECT symbol, market_cap, market_cap / nullif(close_price, 0) AS count
      FROM kr_daily_universe
     WHERE session_date = (SELECT max(session_date) FROM kr_daily_universe)
       AND market_cap > 0 AND close_price > 0
  ),
  bars AS (
    SELECT symbol, session_date, open, high, low, close, volume,
           lag(close) OVER w AS prev_close,
           lead(open) OVER w AS next_open,
           max(close) OVER (PARTITION BY symbol ORDER BY session_date
                            ROWS BETWEEN 60 PRECEDING AND 1 PRECEDING) AS prior_high,
           max(close) OVER (PARTITION BY symbol ORDER BY session_date
                            ROWS BETWEEN 61 PRECEDING AND 2 PRECEDING) AS prior_high_yesterday,
           avg(volume) OVER (PARTITION BY symbol ORDER BY session_date
                             ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_volume,
           count(*) OVER (PARTITION BY symbol ORDER BY session_date
                          ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS history
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  scored AS (
    SELECT b.session_date, b.symbol, s.market_cap,
           (b.next_open / b.close - 1) * 100 AS gap,
           (b.close / b.prev_close - 1) * 100 AS day_move,
           (b.high - b.close) / nullif(b.high - b.low, 0) AS upper_shadow,
           b.volume / nullif(b.avg_volume, 0) AS volume_ratio,
           b.volume / nullif(s.count, 0) * 100 AS turnover_pct,
           b.close > b.open AS bullish,
           b.close > b.prior_high AS broke_today,
           b.prev_close > b.prior_high_yesterday AS broke_yesterday
      FROM bars b
      JOIN shares s ON s.symbol = b.symbol
     WHERE b.next_open IS NOT NULL AND b.prev_close > 0 AND b.close > 0 AND b.high > b.low
       AND b.prior_high IS NOT NULL AND b.prior_high_yesterday IS NOT NULL
       AND b.history >= 20 AND b.close * b.volume >= 1000000000
  ),
  nights AS (
    SELECT session_date, avg(gap) AS night_gap
      FROM scored GROUP BY session_date HAVING count(*) >= 50
  )
  SELECT s.session_date::text AS d, s.symbol, s.market_cap, s.day_move, s.upper_shadow,
         s.volume_ratio, s.turnover_pct, s.bullish, s.broke_today, s.broke_yesterday,
         s.gap - n.night_gap AS excess
    FROM scored s JOIN nights n ON n.session_date = s.session_date
`);

const num = (v) => Number(v);
const nights = new Set(rows.map((r) => r.d)).size;

// 차트 조건은 고정입니다. 이 스크립트가 묻는 것은 강도를 무엇으로 재느냐 하나뿐이라,
// 나머지를 같이 흔들면 무엇 때문에 달라졌는지 알 수 없습니다.
const chart = (r) => r.bullish && r.broke_today && !r.broke_yesterday && num(r.upper_shadow) < 0.3;

const sizes = [
  { label: "대형 1조↑", min: 1e12, max: Infinity, move: 5 },
  { label: "중형 3천억~1조", min: 3e11, max: 1e12, move: 5 },
  { label: "소형 3천억↓", min: 0, max: 3e11, move: 10 }
];
const sizeOf = (r) => sizes.find((s) => num(r.market_cap) >= s.min && num(r.market_cap) < s.max);

function summarise(list) {
  if (list.length === 0) return null;

  const xs = list.map((r) => num(r.excess));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;

  return {
    beat: xs.filter((x) => x > 0).length / xs.length,
    mean,
    n: xs.length,
    perDay: xs.length / nights
  };
}

const show = (label, stats) => {
  if (!stats) {
    console.log(`  ${label.padEnd(22)} 표본 없음`);

    return;
  }

  console.log(`  ${label.padEnd(22)} ${String(stats.n).padStart(5)}건 · 하루 ${stats.perDay.toFixed(1)}건 · 상회 ${Math.round(stats.beat * 100)}% · 초과 ${stats.mean >= 0 ? "+" : ""}${stats.mean.toFixed(3)}%p`);
};

console.log(`\n표본 ${rows.length.toLocaleString("ko-KR")} 종목-밤 · ${nights}개 장 · 종가매수·익일시가매도 · 그날 밤 시장 평균 대비 초과분`);

console.log("\n=== [1] 회전율이 규모마다 얼마나 다른가 ===\n");
console.log("  하나의 문턱으로 될 일인지 먼저 봅니다. 규모별 분포가 크게 다르면 안 됩니다.\n");

for (const size of sizes) {
  const list = rows.filter((r) => sizeOf(r) === size).map((r) => num(r.turnover_pct)).sort((a, b) => a - b);

  if (list.length === 0) continue;

  const q = (p) => list[Math.floor(list.length * p)].toFixed(2);

  console.log(`  ${size.label.padEnd(16)} 중앙값 ${q(0.5)}% · 상위 10% ${q(0.9)}% · 상위 1% ${q(0.99)}%`);
}

console.log("\n=== [2] 현행 — 거래량 배수 (규모별 문턱 셋) ===\n");

const current = (r) => {
  const size = sizeOf(r);

  return chart(r) && num(r.day_move) >= size.move
    && num(r.volume_ratio) >= (size.label.startsWith("소형") ? 2 : 1.5);
};

sizes.forEach((size) => show(size.label, summarise(rows.filter((r) => sizeOf(r) === size && current(r)))));
show("전체", summarise(rows.filter(current)));

console.log("\n=== [3] 대안 — 거래량 배수를 회전율 단일 문턱으로 ===\n");
console.log("  당일 상승률은 규모별 그대로 두고, 거래량 배수만 회전율로 바꿉니다.\n");

for (const cut of [1, 2, 3, 5, 10]) {
  const test = (r) => chart(r) && num(r.day_move) >= sizeOf(r).move && num(r.turnover_pct) >= cut;

  console.log(`  회전율 ${cut}% 이상`);
  sizes.forEach((size) => show(`  ${size.label}`, summarise(rows.filter((r) => sizeOf(r) === size && test(r)))));
  show("  전체", summarise(rows.filter(test)));
  console.log("");
}

console.log("=== [4] 거래량 배수 위에 회전율을 얹으면 ===\n");
console.log("  현행 조건을 만족한 것들만 회전율로 다시 갈라봅니다. 갈라지면 더할 값이 있고,\n  안 갈라지면 같은 것을 두 번 재는 것입니다.\n");

const passing = rows.filter(current);

[[0, 1], [1, 3], [3, 10], [10, Infinity]].forEach(([low, high]) => {
  const list = passing.filter((r) => num(r.turnover_pct) >= low && num(r.turnover_pct) < high);

  show(`회전율 ${low}~${high === Infinity ? "" : high}%`, summarise(list));
});

console.log(`\n${Math.round((Date.now() - started) / 1000)}초`);
process.exit(0);
