import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 기사가 상승보다 먼저 나왔는가, 뒤따라 왔는가.
 *
 *   node scripts/measure-news-lead-lag.mjs
 *
 * 종가배팅 후보 중 뉴스가 있던 것이 +3.871%p로 없던 것(+1.360%p)보다 좋았습니다.
 * 그런데 그것만으로는 원인인지 기록인지 모릅니다 -- 2026-08-28 09:08에 나온
 * "신풍제약 주가, 급등세... 무슨 회사길래?"는 이미 오른 것을 보고 쓴 기사입니다.
 *
 * 분봉과 기사 시각을 붙여서 가릅니다.
 *
 *   기사 시각에 그 종목이 이미 얼마나 올라 있었나
 *   기사 뒤에 얼마나 더 갔나
 *
 * **기사 전에 이미 다 올라 있었다면 그 기사는 원인이 아닙니다.** 뒤에 더 갔다면
 * 원인이거나, 적어도 기사를 보고 들어갈 시간이 있었다는 뜻입니다.
 *
 * 분봉이 짧아 표본이 작습니다. 관찰로 읽으세요.
 */

const config = readConfig();

const { rows } = await query(config, `
  WITH tagged AS (
    SELECT DISTINCT unnest(related_symbols) AS symbol,
           published_at,
           date(published_at AT TIME ZONE 'Asia/Seoul') AS d,
           headline
      FROM market_news_items
     WHERE array_length(related_symbols, 1) > 0 AND headline ~ '[가-힣]'
  ),
  -- 그 기사가 나온 날, 그 종목의 분봉.
  ticks AS (
    SELECT symbol, session_date, observed_at, change_rate
      FROM market_price_samples
     WHERE market = 'KR' AND source LIKE 'kis:krx%' AND change_rate IS NOT NULL
  )
  SELECT t.symbol, t.d::text AS d, t.headline,
         to_char(t.published_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at,
         (SELECT name FROM kr_daily_universe u
           WHERE u.symbol = t.symbol ORDER BY session_date DESC LIMIT 1) AS name,
         -- 기사 직전 등락률. 이 시점에 이미 올라 있었는지.
         (SELECT change_rate FROM ticks k
           WHERE k.symbol = t.symbol AND k.session_date = t.d AND k.observed_at <= t.published_at
           ORDER BY k.observed_at DESC LIMIT 1) AS before_rate,
         -- 기사 뒤 최고·마감.
         (SELECT max(change_rate) FROM ticks k
           WHERE k.symbol = t.symbol AND k.session_date = t.d AND k.observed_at > t.published_at) AS after_high,
         (SELECT change_rate FROM ticks k
           WHERE k.symbol = t.symbol AND k.session_date = t.d
           ORDER BY k.observed_at DESC LIMIT 1) AS session_close,
         -- 그날 전체 최고. 기사 전에 이미 고점을 찍었는지 보려고.
         (SELECT max(change_rate) FROM ticks k
           WHERE k.symbol = t.symbol AND k.session_date = t.d) AS day_high
    FROM tagged t
   WHERE EXISTS (SELECT 1 FROM ticks k WHERE k.symbol = t.symbol AND k.session_date = t.d)
`);

const num = (value) => (value === null || value === undefined ? null : Number(value));
const usable = rows
  .map((row) => ({
    after: num(row.after_high),
    before: num(row.before_rate),
    close: num(row.session_close),
    dayHigh: num(row.day_high),
    ...row
  }))
  .filter((row) => row.before !== null && row.after !== null && row.dayHigh !== null);

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

console.log("");
console.log(`기사 ${usable.length.toLocaleString("ko-KR")}건 · 그날 분봉이 있는 것만`);
console.log("기사 시각을 기준으로 앞뒤를 나눕니다");
console.log("");

/*
 * 기사가 그날 고점의 몇 %를 이미 지난 뒤에 나왔는가.
 *
 * 100%에 가까우면 다 오른 뒤에 쓴 기사이고, 낮으면 오르기 전이나 오르는 중에
 * 나온 것입니다.
 */
const bands = [[-1e9, 0], [0, 3], [3, 10], [10, 20], [20, 1e9]];

console.log("  기사 시점 등락률   건수    기사 뒤 최고   마감    기사 뒤 추가분");
for (const [lo, hi] of bands) {
  const group = usable.filter((row) => row.before > lo && row.before <= hi);

  if (group.length < 20) { console.log(`  ${(lo <= -1e8 ? "마이너스" : `${lo}~${hi > 1e8 ? "" : hi}%`).padEnd(16)} ${String(group.length).padStart(5)}건 — 표본 부족`); continue; }

  const label = lo <= -1e8 ? "마이너스" : `${lo}~${hi > 1e8 ? "" : hi}%`;
  const gain = med(group.map((row) => row.after - row.before));

  console.log(`  ${label.padEnd(16)} ${String(group.length).padStart(5)}건  ${med(group.map((row) => row.after)).toFixed(1).padStart(8)}% ${med(group.map((row) => row.close)).toFixed(1).padStart(7)}%  ${((gain >= 0 ? "+" : "") + gain.toFixed(2)).padStart(9)}%p`);
}

console.log("");
console.log("  ※ '기사 뒤 추가분'이 이 측정의 답입니다. 0에 가까우면 기사는 결과 보도입니다.");

const late = usable.filter((row) => row.dayHigh > 0 && row.before >= row.dayHigh * 0.9);

console.log("");
console.log(`  그날 고점의 90%를 이미 지난 뒤 나온 기사   ${late.length}건 (${Math.round(late.length / usable.length * 100)}%)`);
console.log(`  기사 뒤에 3%p 넘게 더 간 경우            ${usable.filter((row) => row.after - row.before >= 3).length}건 (${Math.round(usable.filter((row) => row.after - row.before >= 3).length / usable.length * 100)}%)`);

const movers = usable.filter((row) => row.dayHigh >= 10).sort((a, b) => (b.after - b.before) - (a.after - a.before));

if (movers.length > 0) {
  console.log("");
  console.log("그날 10%↑ 오른 종목의 기사 — 뒤에 더 간 순서");
  console.log("");
  movers.slice(0, 8).forEach((row) =>
    console.log(`  ${row.at}  ${String(row.name ?? row.symbol).padEnd(12)} 기사시점 ${row.before.toFixed(1).padStart(5)}% → 이후 최고 ${row.after.toFixed(1).padStart(5)}%  (${((row.after - row.before) >= 0 ? "+" : "") + (row.after - row.before).toFixed(1)}%p)`));
  console.log("");
  console.log("  뒤에서부터 — 기사가 늦게 나온 쪽");
  console.log("");
  movers.slice(-5).forEach((row) =>
    console.log(`  ${row.at}  ${String(row.name ?? row.symbol).padEnd(12)} 기사시점 ${row.before.toFixed(1).padStart(5)}% → 이후 최고 ${row.after.toFixed(1).padStart(5)}%  (${((row.after - row.before) >= 0 ? "+" : "") + (row.after - row.before).toFixed(1)}%p)`));
}

process.exit(0);
