import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 눌림목 매매 — 급등 뒤 조정이 끝나는 자리를 사는 것.
 *
 *   npm run kr:pullback
 *
 * 사용자가 실제로 하는 매매 넷 중 마지막입니다. 종가배팅·짝꿍은 쟀고 이건 안 쟀습니다.
 *
 * **이미 반증된 것부터:** [[close-bet-findings]]에서 "20일선 눌림 후 반등"이
 * 57,410건에 −0.013%p(상회 39%)로 나왔습니다. 다만 그것은 **하룻밤 갭**을 잰
 * 것이라 눌림목 매매의 보유 구간이 아닙니다. 눌림목은 다음 파동을 먹는 매매이므로
 * D+1부터 D+10까지 나눠서 다시 잽니다. 하룻밤에 값이 없다는 것은 그대로 사실이고,
 * 여기서 값이 나온다면 그것은 구간이 다르기 때문입니다.
 *
 * ## 원수익과 초과분을 나눠서 봅니다
 *
 * 사용자 관찰: "눌림목은 코스피가 오를 때 다시 오르더라." 그 말이 맞다면 이 매매는
 * **알파가 아니라 베타**일 수 있습니다 -- 시장이 올라서 같이 오른 것이라면 굳이
 * 눌림목을 고를 이유가 없습니다. 그래서 두 숫자를 나란히 냅니다:
 *
 *   원수익    그냥 며칠 뒤 얼마나 올랐나
 *   초과분    같은 구간 전 종목 평균을 뺀 값
 *
 * 원수익만 크고 초과분이 0이면 그건 시장을 산 것입니다.
 *
 * ## 진입 자리 네 가지를 다 잽니다
 *
 *   ma5          급등 후 5일선까지 눌렸다 지지
 *   ma20         20일선까지 더 깊게
 *   prior_high   돌파했던 옛 고점까지 되밀렸다 그 위에서 버팀
 *   fib          급등폭의 33~50% 되돌림
 *
 * 겹칠 수 있습니다(5일선과 피보나치가 같은 가격일 수 있음). 겹침도 같이 봅니다.
 */

const config = readConfig();
const started = Date.now();

// 거래대금 10억 미만은 며칠 뒤 수익률이 호가 몇 칸에 좌우됩니다.
const minimumTurnover = 1_000_000_000;

const measurement = `
WITH base AS (
  SELECT symbol, session_date, open, high, low, close, volume,
         avg(close) OVER w5 AS ma5,
         avg(close) OVER w20 AS ma20,
         -- 오늘을 뺀 최근 15일 최고 종가. 이것이 "직전 파동의 꼭대기"입니다.
         max(close) OVER wpeak AS peak,
         -- 그 파동이 어디서 출발했는가. 40일 최저를 저점으로 씁니다.
         min(close) OVER wtrough AS trough,
         -- 급등 이전의 저항. 41~100일 구간의 최고 종가라 이번 파동에 오염되지
         -- 않습니다. 돌파했던 그 자리가 지지로 바뀌는지를 보려는 것입니다.
         max(close) OVER wprior AS prior_high,
         -- 조정 중 거래가 마르는가를 보려면 분모가 파동의 거래량이어야 합니다.
         max(volume) OVER wpeak AS peak_volume,
         count(*) OVER wcnt AS history,
         lead(close, 1) OVER ws AS c1,
         lead(close, 3) OVER ws AS c3,
         lead(close, 5) OVER ws AS c5,
         lead(close, 10) OVER ws AS c10
    FROM kr_daily_bars
  WINDOW ws AS (PARTITION BY symbol ORDER BY session_date),
         w5 AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 4 PRECEDING AND CURRENT ROW),
         w20 AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
         wpeak AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 15 PRECEDING AND 1 PRECEDING),
         wtrough AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 40 PRECEDING AND 1 PRECEDING),
         wprior AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 100 PRECEDING AND 41 PRECEDING),
         wcnt AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 100 PRECEDING AND CURRENT ROW)
),
-- 시장. 지수 일봉이 없으므로 그날 전 종목 평균 수익률을 시장으로 씁니다.
-- 초과분을 뺄 때 쓰는 것과 같은 정의라 양변이 상쇄됩니다.
market AS (
  SELECT session_date,
         avg((c1 / close - 1) * 100) AS m1,
         avg((c3 / close - 1) * 100) AS m3,
         avg((c5 / close - 1) * 100) AS m5,
         avg((c10 / close - 1) * 100) AS m10
    FROM base
   WHERE close > 0 AND c10 IS NOT NULL
   GROUP BY session_date
  HAVING count(*) >= 100
),
-- 진입 시점에 알 수 있는 시장 상태. 앞으로 오를지는 모르고, 지금까지 올랐는지만
-- 압니다. 미래 수익률로 조건을 걸면 그건 측정이 아니라 사후 설명입니다.
regime AS (
  SELECT session_date,
         avg(CASE WHEN close > ma20 THEN 1.0 ELSE 0 END) AS above_ma20
    FROM base
   WHERE close > 0 AND ma20 > 0 AND history >= 21
   GROUP BY session_date
),
setup AS (
  SELECT b.*,
         b.peak / nullif(b.trough, 0) - 1 AS runup,
         (b.peak - b.close) / nullif(b.peak - b.trough, 0) AS retrace,
         b.volume::numeric / nullif(b.peak_volume, 0) AS volume_dry,
         r.above_ma20
    FROM base b
    JOIN regime r ON r.session_date = b.session_date
   WHERE b.history >= 101 AND b.close > 0 AND b.trough > 0 AND b.peak > 0
     AND b.c10 IS NOT NULL
     AND b.close * b.volume >= ${minimumTurnover}
     -- 앞선 급등이 있어야 눌림입니다. 25% 못 오른 종목의 하락은 그냥 하락입니다.
     AND b.peak / nullif(b.trough, 0) - 1 >= 0.25
     -- 그리고 지금 눌려 있어야 합니다. 고점을 3%도 안 내준 것은 조정이 아닙니다.
     AND b.close < b.peak * 0.97
),
flagged AS (
  SELECT s.*,
         -- 닿았다가 지켰는가. 저가로 닿고 종가는 위에 있어야 지지입니다.
         (s.low <= s.ma5 * 1.01 AND s.close >= s.ma5 * 0.99) AS at_ma5,
         (s.low <= s.ma20 * 1.01 AND s.close >= s.ma20 * 0.99) AS at_ma20,
         (s.prior_high > 0 AND s.low <= s.prior_high * 1.03 AND s.close >= s.prior_high) AS at_prior_high,
         (s.retrace BETWEEN 0.33 AND 0.50) AS at_fib,
         (s.volume_dry <= 0.5) AS dry,
         -- 돌아서는 순간. 지지선에 닿기만 한 날과, 닿고 양봉으로 돌아선 날은
         -- 다른 자리입니다. 실제 진입은 후자입니다.
         (s.close > s.open) AS turned
    FROM setup s
)
SELECT f.session_date::text AS d, f.symbol,
       f.at_ma5, f.at_ma20, f.at_prior_high, f.at_fib, f.dry, f.turned,
       round((f.runup * 100)::numeric, 1) AS runup,
       round((f.retrace * 100)::numeric, 1) AS retrace,
       round(f.above_ma20::numeric, 3) AS breadth,
       (f.c1 / f.close - 1) * 100 AS r1,
       (f.c3 / f.close - 1) * 100 AS r3,
       (f.c5 / f.close - 1) * 100 AS r5,
       (f.c10 / f.close - 1) * 100 AS r10,
       (f.c1 / f.close - 1) * 100 - m.m1 AS e1,
       (f.c3 / f.close - 1) * 100 - m.m3 AS e3,
       (f.c5 / f.close - 1) * 100 - m.m5 AS e5,
       (f.c10 / f.close - 1) * 100 - m.m10 AS e10,
       m.m5 AS market5
  FROM flagged f
  JOIN market m ON m.session_date = f.session_date
`;

const { rows } = await query(config, measurement);
const num = (v) => Number(v);
const sessions = new Set(rows.map((r) => r.d)).size;

console.log(`\n표본 ${rows.length.toLocaleString("ko-KR")} 종목-일 · ${sessions}개 장`);
console.log(`설정: 직전 15일 고점까지 25%↑ 오른 뒤 3% 이상 눌린 상태 · 거래대금 10억↑\n`);

function stats(list, horizon) {
  if (list.length === 0) return null;

  const raw = list.map((r) => num(r[`r${horizon}`]));
  const exc = list.map((r) => num(r[`e${horizon}`]));
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  return {
    beat: exc.filter((x) => x > 0).length / exc.length,
    excess: mean(exc),
    n: list.length,
    raw: mean(raw),
    win: raw.filter((x) => x > 0).length / raw.length
  };
}

const all = rows;

function line(label, list, horizon) {
  const s = stats(list, horizon);

  if (!s) return console.log(`  ${label.padEnd(20)} 표본 없음`);

  const sign = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;

  console.log(`  ${label.padEnd(20)} ${String(s.n).padStart(6)}건 · 원수익 ${sign(s.raw).padStart(7)}% (승 ${Math.round(s.win * 100)}%) · 초과 ${sign(s.excess).padStart(7)}%p (상회 ${Math.round(s.beat * 100)}%)`);
}

const variants = [
  { key: "at_ma5", label: "5일선 지지" },
  { key: "at_ma20", label: "20일선 지지" },
  { key: "at_prior_high", label: "전고점 되돌림" },
  { key: "at_fib", label: "33~50% 되돌림" }
];

for (const horizon of [1, 3, 5, 10]) {
  console.log(`=== D+${horizon} 보유 ===\n`);
  line("전체 (눌림 상태)", all, horizon);
  variants.forEach((v) => line(v.label, all.filter((r) => r[v.key] && r.dry), horizon));
  console.log("");
}

/**
 * 거래량이 마르는 조건이 값을 더하는가.
 *
 * 필수로 넣기로 했지만, 넣어서 좋아지는지는 별개 문제입니다. 안 좋아지면 후보만
 * 줄이는 조건이 됩니다.
 */
console.log("=== 거래량 마름 조건의 값 (D+5) ===\n");
variants.forEach((v) => {
  line(`${v.label} · 마름`, all.filter((r) => r[v.key] && r.dry), 5);
  line(`${v.label} · 안 마름`, all.filter((r) => r[v.key] && !r.dry), 5);
});

/**
 * 사용자 관찰 — "코스피 오를 때 다시 오른다".
 *
 * 진입 시점에 알 수 있는 시장 상태(20일선 위 종목 비율)로 나눕니다. 앞으로 오를지를
 * 조건으로 쓰면 사후 설명이 됩니다.
 */
console.log("\n=== 시장 상태별 (D+5, 진입일 기준 20일선 위 종목 비율) ===\n");

const regimes = [
  { label: "약세 (40% 미만)", test: (r) => num(r.breadth) < 0.4 },
  { label: "중립 (40~55%)", test: (r) => num(r.breadth) >= 0.4 && num(r.breadth) < 0.55 },
  { label: "강세 (55% 이상)", test: (r) => num(r.breadth) >= 0.55 }
];

variants.forEach((v) => {
  console.log(`${v.label}`);
  regimes.forEach((g) => line(`  ${g.label}`, all.filter((r) => r[v.key] && r.dry && g.test(r)), 5));
});

/**
 * 시장이 실제로 오른 구간과 내린 구간.
 *
 * 진입 조건으로는 못 쓰지만, "이 매매가 알파인가 베타인가"에는 답합니다. 시장이
 * 내린 구간에서도 초과분이 남으면 종목 선택에 값이 있는 것이고, 원수익만 시장을
 * 따라 움직이면 그냥 시장을 산 것입니다.
 */
console.log("\n=== 시장이 실제로 어떻게 갔는가 (D+5, 사후 분류) ===\n");
variants.forEach((v) => {
  const list = all.filter((r) => r[v.key] && r.dry);

  line(`${v.label} · 시장 상승`, list.filter((r) => num(r.market5) > 0), 5);
  line(`${v.label} · 시장 하락`, list.filter((r) => num(r.market5) <= 0), 5);
});

/**
 * 양봉으로 돌아선 날만.
 *
 * 위까지는 지지선에 닿은 모든 날입니다. 실제 매매는 닿고 **돌아서는** 것을 보고
 * 들어가므로, 그 조건을 더하면 자리가 좁아지는 대신 값이 생길 수 있습니다.
 */
console.log("\n=== 양봉으로 돌아선 날만 (거래량 마름 포함) ===\n");

for (const horizon of [3, 5, 10]) {
  console.log(`D+${horizon}`);
  variants.forEach((v) => line(`  ${v.label}`, all.filter((r) => r[v.key] && r.dry && r.turned), horizon));
  console.log("");
}

console.log("=== 양봉 전환 + 강세장만 (D+5) ===\n");
variants.forEach((v) => line(v.label, all.filter((r) => r[v.key] && r.dry && r.turned && num(r.breadth) >= 0.55), 5));

/**
 * 국면 자체가 예측력이 있는가.
 *
 * 위 표에서 강세장일 때만 원수익이 플러스인데, 그것이 눌림목의 성질인지 시장의
 * 성질인지 갈라야 합니다. 진입일의 "20일선 위 종목 비율"로 나눠서 **시장 자신의**
 * 5일 뒤 수익률을 봅니다. 여기서 갈리면 국면 지표는 눌림목과 무관하게 값이 있고,
 * 안 갈리면 위 표의 강세/약세 차이는 다른 이유입니다.
 */
console.log("\n=== 국면이 시장 자체를 예측하는가 (D+5 시장 평균) ===\n");

const bySession = new Map();

all.forEach((row) => {
  if (!bySession.has(row.d)) bySession.set(row.d, { breadth: num(row.breadth), market: num(row.market5) });
});

const days = [...bySession.values()];

regimes.forEach((g) => {
  const list = days.filter((day) => g.test({ breadth: day.breadth }));

  if (list.length === 0) return console.log(`  ${g.label.padEnd(16)} 표본 없음`);

  const mean = list.reduce((sum, day) => sum + day.market, 0) / list.length;
  const up = list.filter((day) => day.market > 0).length / list.length;

  console.log(`  ${g.label.padEnd(16)} ${String(list.length).padStart(4)}개 장 · 5일 뒤 시장 ${mean >= 0 ? "+" : ""}${mean.toFixed(3)}% · 오른 장 ${Math.round(up * 100)}%`);
});

console.log(`\n${Math.round((Date.now() - started) / 1000)}초`);
process.exit(0);
