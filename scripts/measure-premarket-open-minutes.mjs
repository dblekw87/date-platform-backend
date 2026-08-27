import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 프리마켓에서 크게 오른 종목을 개장에 사면, 5분·10분·30분 뒤에 어떻게 되는가.
 *
 *   node scripts/measure-premarket-open-minutes.mjs
 *
 * 앞선 측정([[measure-premarket-followthrough]])은 하루 단위였습니다. 프리마켓
 * 150%↑ 296건 중 41%가 정규장 고가로 +30% 이상 갔지만 72%는 종가에 프리마켓
 * 아래였다 -- 그 사이에 무슨 일이 있었는지는 못 봤습니다.
 *
 * 진입은 정규장 첫 봉의 시가입니다. 실제로 살 수 있는 첫 가격이고, 프리마켓
 * 마지막 가격으로 재면 개장갭이 공짜 수익으로 잡힙니다.
 *
 * 봉이 5분이라 5분=1봉, 10분=2봉, 30분=6봉입니다. 각 구간의 **고가와 종가를 같이**
 * 냅니다 -- 고가만 보면 스치고 지나간 값을 먹은 것으로 세게 되고, 그건 지정가로
 * 팔았을 때만 받는 값입니다.
 *
 * 마지막 절이 이 측정의 목적입니다: 5분 시점의 상태로 30분 결과를 가릴 수 있는가.
 * 가릴 수 없으면 단타로 성립하지 않습니다 -- 들어가고 나서야 알게 되니까요.
 */

const config = readConfig();

const { rows } = await query(config, `
  WITH pre AS (
    SELECT symbol, session_date, (array_agg(close ORDER BY observed_at DESC))[1] AS pre_last
      FROM us_intraday_bars WHERE phase='pre' GROUP BY symbol, session_date
  ),
  reg AS (
    SELECT symbol, session_date, observed_at, open, high, low, close, volume,
           row_number() OVER (PARTITION BY symbol, session_date ORDER BY observed_at) AS bar
      FROM us_intraday_bars WHERE phase='regular'
  ),
  prev AS (
    SELECT symbol, session_date,
           lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev_close
      FROM us_daily_bars
  )
  SELECT r.symbol, r.session_date::text AS d,
         (p.pre_last / v.prev_close - 1) * 100 AS pre_gain,
         max(r.open) FILTER (WHERE r.bar = 1) AS entry,
         max(r.high) FILTER (WHERE r.bar = 1) AS h5,
         max(r.close) FILTER (WHERE r.bar = 1) AS c5,
         min(r.low) FILTER (WHERE r.bar = 1) AS l5,
         max(r.high) FILTER (WHERE r.bar <= 2) AS h10,
         max(r.close) FILTER (WHERE r.bar = 2) AS c10,
         max(r.high) FILTER (WHERE r.bar <= 6) AS h30,
         max(r.close) FILTER (WHERE r.bar = 6) AS c30,
         min(r.low) FILTER (WHERE r.bar <= 6) AS l30,
         sum(r.volume) FILTER (WHERE r.bar <= 6) AS vol30
    FROM reg r
    JOIN pre p ON p.symbol = r.symbol AND p.session_date = r.session_date
    JOIN prev v ON v.symbol = r.symbol AND v.session_date = r.session_date
   WHERE v.prev_close > 0 AND p.pre_last > 0
   GROUP BY r.symbol, r.session_date, p.pre_last, v.prev_close
  HAVING sum(r.volume) FILTER (WHERE r.bar <= 6) >= 50000
     AND max(r.open) FILTER (WHERE r.bar = 1) > 0
     AND max(r.close) FILTER (WHERE r.bar = 6) IS NOT NULL
`);

const num = (v) => Number(v);
const pct = (a, b) => (num(a) / num(b) - 1) * 100;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const bands = [[20, 50], [50, 100], [100, 150], [150, 300], [300, 1e9]];

console.log(`\n표본 ${rows.length.toLocaleString("ko-KR")} 종목-날 · 2024-08 ~ 2026-08`);
console.log(`진입은 **정규장 첫 봉 시가**. 전부 중앙값입니다.\n`);
console.log("  프리마켓  표본   5분 고가  5분 종가  10분 고가  30분 고가  30분 종가  30분 저가");

for (const [lo, hi] of bands) {
  const g = rows.filter((r) => num(r.pre_gain) > lo && num(r.pre_gain) <= hi);

  if (g.length < 10) { console.log(`  ${(lo + "~" + (hi > 1e8 ? "" : hi) + "%").padEnd(9)} ${String(g.length).padStart(4)} — 부족`); continue; }

  const col = (f) => { const v = med(g.map(f)); return ((v >= 0 ? "+" : "") + v.toFixed(1) + "%").padStart(9); };

  console.log(`  ${(lo + "~" + (hi > 1e8 ? "" : hi) + "%").padEnd(9)} ${String(g.length).padStart(4)}${col((r) => pct(r.h5, r.entry))}${col((r) => pct(r.c5, r.entry))}${col((r) => pct(r.h10, r.entry))}${col((r) => pct(r.h30, r.entry))}${col((r) => pct(r.c30, r.entry))}${col((r) => pct(r.l30, r.entry))}`);
}

console.log("\n\n[단타로 성립하는가] 5분 시점의 상태로 30분 뒤를 가릴 수 있는가\n");

for (const [lo, hi] of [[100, 150], [150, 300], [300, 1e9]]) {
  const g = rows.filter((r) => num(r.pre_gain) > lo && num(r.pre_gain) <= hi);

  if (g.length < 30) continue;

  const up = g.filter((r) => pct(r.c5, r.entry) > 0);
  const down = g.filter((r) => pct(r.c5, r.entry) <= 0);
  const line = (label, list) => {
    if (list.length < 10) return `  ${label.padEnd(26)} ${list.length}건 — 부족`;

    const to30 = med(list.map((r) => pct(r.c30, r.entry)));
    const win = list.filter((r) => pct(r.c30, r.entry) > 0).length;

    return `  ${label.padEnd(26)} ${String(list.length).padStart(4)}건 · 30분 종가 ${((to30 >= 0 ? "+" : "") + to30.toFixed(1) + "%").padStart(7)} · 플러스로 끝난 비율 ${Math.round(win / list.length * 100)}%`;
  };

  console.log(`  프리마켓 ${lo}~${hi > 1e8 ? "" : hi}%  (${g.length}건)`);
  console.log(line("5분봉이 시가 위로 마감", up));
  console.log(line("5분봉이 시가 아래로 마감", down));
  console.log("");
}

console.log("[최악을 얼마나 견뎌야 하는가] 30분 안 저가\n");
for (const [lo, hi] of bands) {
  const g = rows.filter((r) => num(r.pre_gain) > lo && num(r.pre_gain) <= hi);

  if (g.length < 10) continue;

  const draw = g.map((r) => pct(r.l30, r.entry));

  console.log(`  ${(lo + "~" + (hi > 1e8 ? "" : hi) + "%").padEnd(9)} 중앙 ${med(draw).toFixed(1).padStart(6)}% · −10% 아래로 간 비율 ${Math.round(draw.filter((x) => x <= -10).length / draw.length * 100)}% · −20% 아래 ${Math.round(draw.filter((x) => x <= -20).length / draw.length * 100)}%`);
}

process.exit(0);
