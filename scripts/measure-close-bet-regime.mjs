import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";
import { closeBetCandidateSql } from "../src/providers/close-bet.mjs";

/**
 * 중·대형 종가배팅이 시장 국면에 따라 달라지는가.
 *
 *   node scripts/measure-close-bet-regime.mjs
 *
 * 사용자 가설(2026-10-16): "대 상승장일 땐 대형·중형 종가배팅 확률도 오를 것, 지금은
 * 하락장이라 그렇다. 6월 이후 자금이 빠지고 개인이 지쳤다." 그리고 10-18에 덧붙임:
 * "거래대금이 확 몰리면 그때가 사실 상승장 시작이다."
 *
 * 그래서 국면을 세 자로 나눕니다. 셋 다 **그날 종가에 이미 알 수 있는 값**입니다.
 *
 *   지수 20일    최근 시총 상위 30종목 고정 가중 평균의 20거래일 누적 수익률
 *                (measure-crash-day-rotation.mjs와 같은 지수 대용)
 *   거래대금 수준  전 종목 close × volume 합의 20일 평균. 일봉 종가가 애프터 가격을 섞어
 *                ([[krx-after-market-2026-09-14]]) 대략값입니다
 *   거래대금 급증  5일 평균 ÷ 60일 평균. 1.3배 이상이면 "몰리는 중"
 *
 * 후보는 화면과 같은 SQL(closeBetCandidateSql)입니다. 초과는 그날 밤 시장 평균 갭
 * 대비이고, 기준선은 거래대금 5억 이상 · 익일 시가 > 0 · 갭 −31% 초과로 둡니다
 * (open = 0 행이 평균을 1.3%p 밀었던 일 -- measurement-pitfalls).
 *
 * **같은 국면은 날짜가 붙어 있습니다.** 한 칸의 100건이 한두 달에서 나왔다면 사실상
 * 그 몇 주의 표본입니다. 그래서 건수 옆에 장 수와 "장별 평균이 플러스였던 장 비율"을
 * 같이 봅니다.
 */

const config = readConfig();
const started = Date.now();

const { rows: days } = await query(config, `
  WITH w AS (
    SELECT symbol, market_cap::float8 AS cap FROM (
      SELECT DISTINCT ON (symbol) symbol, market_cap
        FROM kr_daily_universe WHERE market_cap > 0
       ORDER BY symbol, session_date DESC) t
     ORDER BY market_cap DESC LIMIT 30
  ),
  b AS (
    SELECT symbol, session_date, open, close, volume,
           lag(close) OVER x AS prev_close,
           lead(open) OVER x AS next_open
      FROM kr_daily_bars
    WINDOW x AS (PARTITION BY symbol ORDER BY session_date)
  )
  SELECT b.session_date::text AS d,
         sum((b.close / b.prev_close - 1) * 100 * w.cap) FILTER (WHERE w.cap IS NOT NULL AND b.prev_close > 0 AND b.close / b.prev_close > 0.69)
           / nullif(sum(w.cap) FILTER (WHERE w.cap IS NOT NULL AND b.prev_close > 0 AND b.close / b.prev_close > 0.69), 0) AS idx_ret,
         sum(b.close * b.volume) FILTER (WHERE b.open > 0 AND b.close > 0) / 1e12 AS value_jo,
         avg((b.next_open / b.close - 1) * 100) FILTER (
           WHERE b.next_open > 0 AND b.close > 0 AND b.close * b.volume >= 500000000
             AND b.next_open / b.close > 0.69) AS night_gap,
         count(*) FILTER (WHERE b.next_open > 0 AND b.close * b.volume >= 500000000) AS night_n
    FROM b LEFT JOIN w USING (symbol)
   GROUP BY 1
  HAVING count(*) > 1000
   ORDER BY 1
`);

const { rows: picks } = await query(config, `
  WITH c AS (${closeBetCandidateSql()})
  SELECT session_date::text AS d, symbol, size_label, day_move,
         (next_open / close - 1) * 100 AS gap
    FROM c
   WHERE next_open > 0 AND next_open / close > 0.69
`);

const num = (v) => Number(v);
const byDay = new Map();

days.forEach((day, i) => {
  const at = (back) => days[i - back];
  const window = (n, key) => {
    if (i - n + 1 < 0) return null;

    const xs = days.slice(i - n + 1, i + 1).map((x) => num(x[key]));

    return xs.reduce((a, b) => a + b, 0) / n;
  };
  const compound = (from, to) => {
    if (from < 0 || to >= days.length) return null;

    return (days.slice(from, to + 1).reduce((acc, x) => acc * (1 + num(x.idx_ret || 0) / 100), 1) - 1) * 100;
  };

  byDay.set(day.d, {
    d: day.d,
    forward20: compound(i + 1, i + 20),
    idx20: at(19) ? compound(i - 19, i) : null,
    nightGap: num(day.night_n) >= 50 ? num(day.night_gap) : null,
    surge: i >= 59 ? window(5, "value_jo") / window(60, "value_jo") : null,
    value20: window(20, "value_jo")
  });
});

const scored = picks
  .map((p) => ({ ...p, day: byDay.get(p.d) }))
  .filter((p) => p.day && p.day.nightGap !== null && p.day.idx20 !== null)
  .map((p) => ({ ...p, excess: num(p.gap) - p.day.nightGap }));

const median = (xs) => {
  if (xs.length === 0) return NaN;

  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);

  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sign = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

function show(label, list) {
  if (list.length === 0) {
    console.log(`  ${label.padEnd(24)}     0건`);

    return;
  }

  const xs = list.map((r) => r.excess);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const perDay = new Map();

  list.forEach((r) => perDay.set(r.d, [...(perDay.get(r.d) || []), r.excess]));

  const dayMeans = [...perDay.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  const months = new Set(list.map((r) => r.d.slice(0, 7))).size;

  console.log(`  ${label.padEnd(24)} ${String(list.length).padStart(5)}건 · ${String(perDay.size).padStart(3)}장 · ${String(months).padStart(2)}개월`
    + ` · 평균 ${sign(mean).padStart(6)} · 중앙 ${sign(median(xs)).padStart(6)}`
    + ` · 상회 ${String(Math.round(100 * xs.filter((x) => x > 0).length / xs.length)).padStart(3)}%`
    + ` · 장 플러스 ${String(Math.round(100 * dayMeans.filter((x) => x > 0).length / dayMeans.length)).padStart(3)}%`);
}

const midLarge = scored.filter((r) => r.size_label === "대형" || r.size_label === "중형");
const small = scored.filter((r) => r.size_label === "소형");
const first = scored.reduce((a, r) => (r.d < a ? r.d : a), "9999");
const last = scored.reduce((a, r) => (r.d > a ? r.d : a), "0000");

console.log(`\n후보 ${scored.length.toLocaleString("ko-KR")}건 (중·대형 ${midLarge.length} · 소형 ${small.length}) · ${first} ~ ${last}`);
console.log("종가매수 · 익일시가매도 · 그날 밤 시장 평균 갭 대비 초과(%p)");

const cuts = [
  {
    bands: [["하락 (−3% 미만)", (x) => x < -3], ["횡보 (−3~+3%)", (x) => x >= -3 && x < 3], ["상승 (+3~+10%)", (x) => x >= 3 && x < 10], ["강한 상승 (+10%↑)", (x) => x >= 10]],
    key: "idx20",
    title: "[1] 지수 20일 수익률 (시총 상위 30 가중)"
  },
  {
    bands: [["40조 미만", (x) => x < 40], ["40~60조", (x) => x >= 40 && x < 60], ["60~80조", (x) => x >= 60 && x < 80], ["80조 이상", (x) => x >= 80]],
    key: "value20",
    title: "[2] 시장 거래대금 수준 (20일 평균, 대략)"
  },
  {
    bands: [["마름 (0.8배 미만)", (x) => x < 0.8], ["보통 (0.8~1.1배)", (x) => x >= 0.8 && x < 1.1], ["늘어남 (1.1~1.3배)", (x) => x >= 1.1 && x < 1.3], ["몰림 (1.3배 이상)", (x) => x >= 1.3]],
    key: "surge",
    title: "[3] 거래대금 급증 (5일 평균 ÷ 60일 평균)"
  }
];

for (const cut of cuts) {
  console.log(`\n=== ${cut.title} ===`);

  for (const [group, list] of [["중·대형", midLarge], ["대형", midLarge.filter((r) => r.size_label === "대형")], ["중형", midLarge.filter((r) => r.size_label === "중형")], ["소형 (비교)", small]]) {
    console.log(`\n ${group}`);
    cut.bands.forEach(([label, test]) => show(label, list.filter((r) => r.day[cut.key] !== null && test(r.day[cut.key]))));
  }
}

console.log("\n=== [4] 지수 국면 × 거래대금 급증 (중·대형) ===\n");

for (const [trend, t] of [["지수 하락·횡보", (x) => x < 3], ["지수 상승", (x) => x >= 3]]) {
  for (const [flow, f] of [["몰림 아님", (x) => x < 1.3], ["몰림", (x) => x >= 1.3]]) {
    show(`${trend} · ${flow}`, midLarge.filter((r) => r.day.surge !== null && t(r.day.idx20) && f(r.day.surge)));
  }
}

console.log("\n=== [5] 전제 확인 — 거래대금이 몰린 뒤 지수가 올랐나 ===\n");
console.log("  그날 급증 배수로 가르고, 다음 20거래일 지수 대용 누적 수익률. 겹치는 창이라 장 수만큼 독립이 아닙니다.\n");

const all = [...byDay.values()].filter((x) => x.surge !== null && x.forward20 !== null);

cuts[2].bands.forEach(([label, test]) => {
  const list = all.filter((x) => test(x.surge));

  if (list.length === 0) return console.log(`  ${label.padEnd(24)}   0장`);

  const xs = list.map((x) => x.forward20);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;

  console.log(`  ${label.padEnd(24)} ${String(list.length).padStart(4)}장 · 이후 20일 지수 평균 ${sign(mean)}% · 중앙 ${sign(median(xs))}% · 오른 비율 ${Math.round(100 * xs.filter((x) => x > 0).length / xs.length)}%`);
});

console.log("\n  몰림이 시작된 날만 (직전 10장 동안 1.3배 미만이었다가 처음 넘은 날)\n");

const ordered = [...byDay.values()].filter((x) => x.surge !== null);

ordered.forEach((x, i) => {
  const quiet = ordered.slice(Math.max(0, i - 10), i).every((y) => y.surge < 1.3);

  if (x.surge < 1.3 || !quiet || i < 10) return;

  console.log(`  ${x.d}  급증 ${x.surge.toFixed(2)} · 그때까지 지수 20일 ${sign(x.idx20)}% · 이후 20일 ${x.forward20 === null ? "  -  " : `${sign(x.forward20)}%`}`);
});

console.log("\n=== [6] 월별 국면 (참고) ===\n");

const months = new Map();

[...byDay.values()].forEach((x) => {
  const m = x.d.slice(0, 7);

  months.set(m, [...(months.get(m) || []), x]);
});

for (const [m, list] of months) {
  const lastDay = list[list.length - 1];
  const ml = midLarge.filter((r) => r.d.startsWith(m));
  const xs = ml.map((r) => r.excess);

  console.log(`  ${m}  거래대금 20일 ${lastDay.value20 === null ? "  -  " : lastDay.value20.toFixed(1).padStart(5)}조`
    + ` · 지수 20일 ${lastDay.idx20 === null ? "   -  " : sign(lastDay.idx20).padStart(6)}%`
    + ` · 급증 ${lastDay.surge === null ? "  - " : lastDay.surge.toFixed(2)}`
    + ` · 중·대형 ${String(ml.length).padStart(3)}건${xs.length ? ` 중앙 ${sign(median(xs))}` : ""}`);
}

console.log(`\n${Math.round((Date.now() - started) / 1000)}초`);
process.exit(0);
