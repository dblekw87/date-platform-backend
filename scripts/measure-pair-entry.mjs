import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 짝꿍매매를 **화면이 말하는 자리에서** 잽니다.
 *
 *   node scripts/measure-pair-entry.mjs [--gap 6]
 *
 * `measure-pair-intraday.mjs`는 알림이 발동하는 자리를 쟀습니다 -- 1등주가 잠긴 뒤
 * 3분 안의 **첫 틱**이고, 그때 2등주가 +10%든 +27%든 잡습니다. 그 자리는 값이
 * 없었습니다(149건 −2.41%). 그런데 그것은 사장님이 하는 진입이 아닙니다.
 *
 * 실제 진입은 **간격이 좁혀졌을 때**입니다. 1등주가 상한가에 잠겨 있고 2등주가
 * 6%p 안으로 따라붙은 순간이 자리이고, 화면은 장중 내내 그 상태를 다시 계산해
 * 보여줍니다. 2026-08-27 유디엠텍 → 라온피플이 그 차이입니다.
 *
 *   12:33  1등주 잠김 · 2등주 +16.12%   간격 13.84%p   ← 알림이 잡는 자리
 *   13:14                  +28.97%       0.99%p        ← 화면이 짝이라고 말하는 자리
 *
 * **사후 재구성이 아닙니다.** 진입 조건에 쓰는 값은 그 분에 이미 알 수 있는 것뿐
 * 입니다 -- 1등주가 지금 잠겨 있는가, 2등주가 지금 얼마나 붙어 있는가. 뒤를 보고
 * 고르는 것이 하나도 없습니다.
 *
 * 대조군은 **같은 분에 비슷하게 올라 있던 다른 종목**입니다. 2등주가 +24% 근처이므로
 * "+10~29% 아무거나"로는 비교가 안 됩니다 -- 그 구간은 대부분 훨씬 덜 오른 종목이고,
 * 많이 오른 종목이 그 뒤 어떻게 되는지와 섞이면 짝의 몫을 알 수 없습니다.
 */

const config = readConfig();
const maxGap = Number(process.argv.find((word, at) => process.argv[at - 1] === "--gap") ?? 6);
const num = (value) => (value === null || value === undefined ? null : Number(value));
const pct = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

/** 진입가 대비. 둘 다 전일 종가 기준이므로 비율로 나눕니다. */
function moveFrom(entryRate, rate) {
  const base = 100 + entryRate;

  if (!(base > 0)) return null;

  return ((100 + rate) / base - 1) * 100;
}

function stats(values) {
  const xs = values.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);

  if (xs.length === 0) return null;

  return {
    count: xs.length,
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    median: xs[Math.floor(xs.length / 2)],
    win: xs.filter((x) => x > 0).length / xs.length * 100,
    worst: xs[0]
  };
}

function report(label, values) {
  const s = stats(values);

  if (!s) {
    console.log(`  ${label.padEnd(24)}     0건  -`);

    return;
  }

  console.log(`  ${label.padEnd(24)} ${String(s.count).padStart(5)}건  평균 ${pct(s.mean).padStart(8)}` +
    `  중앙 ${pct(s.median).padStart(8)}  상회 ${s.win.toFixed(0).padStart(3)}%  최악 ${pct(s.worst).padStart(8)}`);
}

/*
 * 무거운 조인을 SQL에 두면 몇 분씩 걸립니다. 필요한 것만 받아 여기서 맞춥니다.
 * 받는 것은 상한가 잠금이 있었던 테마의 회원 틱뿐이라, 전 종목을 끌어오지 않습니다.
 */
const { rows: locks } = await query(config, `
  WITH ticks AS (
    SELECT DISTINCT ON (session_date, symbol, date_trunc('minute', observed_at))
           session_date, symbol, observed_at, change_rate
      FROM market_price_samples
     WHERE market = 'KR' AND source LIKE 'kis:krx%' AND change_rate IS NOT NULL
       AND (observed_at AT TIME ZONE 'Asia/Seoul')::time BETWEEN '09:00' AND '15:30'
     ORDER BY session_date, symbol, date_trunc('minute', observed_at), observed_at DESC
  )
  SELECT DISTINCT ON (session_date, symbol)
         session_date::text AS d, symbol, extract(epoch FROM observed_at) AS lock_epoch
    FROM ticks
   WHERE change_rate >= 29.5
   ORDER BY session_date, symbol, observed_at
`);

const { rows: memberRows } = await query(config, `
  SELECT DISTINCT symbol, theme_name
    FROM kr_theme_membership
   WHERE theme_name !~ '(밸류업|기업인수목적|신규상장|리츠|지주사)'
`);

const themesOf = new Map();

for (const row of memberRows) {
  const list = themesOf.get(row.symbol) ?? new Set();

  list.add(row.theme_name);
  themesOf.set(row.symbol, list);
}

const membersOf = new Map();

for (const row of memberRows) {
  const list = membersOf.get(row.theme_name) ?? [];

  list.push(row.symbol);
  membersOf.set(row.theme_name, list);
}

const { rows: tickRows } = await query(config, `
  SELECT DISTINCT ON (session_date, symbol, date_trunc('minute', observed_at))
         session_date::text AS d, symbol, change_rate,
         extract(epoch FROM observed_at) AS epoch,
         to_char(observed_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS t
    FROM market_price_samples
   WHERE market = 'KR' AND source LIKE 'kis:krx%' AND change_rate IS NOT NULL
     AND (observed_at AT TIME ZONE 'Asia/Seoul')::time BETWEEN '09:00' AND '15:30'
   ORDER BY session_date, symbol, date_trunc('minute', observed_at), observed_at DESC
`);

const paths = new Map();

for (const row of tickRows) {
  const key = `${row.d}|${row.symbol}`;
  const path = paths.get(key) ?? [];

  path.push({ epoch: num(row.epoch), rate: num(row.change_rate), t: row.t });
  paths.set(key, path);
}

for (const path of paths.values()) path.sort((a, b) => a.epoch - b.epoch);

/** 그 시각의 마지막 값. 5분 격자라 정확히 일치하는 틱이 없을 수 있습니다. */
function rateAt(day, symbol, epoch) {
  const path = paths.get(`${day}|${symbol}`);

  if (!path) return null;

  let found = null;

  for (const tick of path) {
    if (tick.epoch > epoch) break;
    found = tick;
  }

  return found ? found.rate : null;
}

/*
 * 진입 자리를 만듭니다.
 *
 * 1등주가 잠긴 뒤로 걸어가면서, 2등주가 처음으로 간격 안에 들어온 순간을 잡습니다.
 * 이미 상한가인 2등주는 뺍니다 -- 살 수가 없습니다.
 */
const entries = [];

for (const lock of locks) {
  const leaderThemes = themesOf.get(lock.symbol);

  if (!leaderThemes) continue;

  const candidates = new Set();

  for (const theme of leaderThemes) {
    for (const symbol of membersOf.get(theme) ?? []) {
      if (symbol !== lock.symbol) candidates.add(symbol);
    }
  }

  for (const symbol of candidates) {
    const path = paths.get(`${lock.d}|${symbol}`);

    if (!path) continue;

    const lockEpoch = num(lock.lock_epoch);

    for (const tick of path) {
      if (tick.epoch < lockEpoch) continue;

      const leaderRate = rateAt(lock.d, lock.symbol, tick.epoch);

      if (leaderRate === null) continue;

      const gap = leaderRate - tick.rate;

      if (gap > maxGap || tick.rate >= 29.5) continue;

      entries.push({
        d: lock.d, entryEpoch: tick.epoch, entryRate: tick.rate, entryTime: tick.t,
        gap, leader: lock.symbol, leaderRate, symbol
      });
      break;
    }
  }
}

/*
 * 같은 날 같은 종목이 여러 1등주에 걸립니다. 화면이 고르는 것과 같게, 간격이 가장
 * 좁은 짝만 남깁니다 -- 남기지 않으면 테마를 여럿 단 종목이 표본을 부풀립니다.
 */
const best = new Map();

for (const entry of entries) {
  const key = `${entry.d}|${entry.symbol}`;
  const held = best.get(key);

  if (!held || entry.gap < held.gap) best.set(key, entry);
}

const picked = [...best.values()].sort((a, b) => (a.d === b.d ? a.entryEpoch - b.entryEpoch : a.d < b.d ? -1 : 1));

/** 진입 뒤의 길. 여기서 결과가 나옵니다. */
const measured = picked.map((entry) => {
  const path = (paths.get(`${entry.d}|${entry.symbol}`) ?? []).filter((tick) => tick.epoch >= entry.entryEpoch);
  const walk = path.map((tick) => ({ ...tick, move: moveFrom(entry.entryRate, tick.rate) }));
  const leaderPath = (paths.get(`${entry.d}|${entry.leader}`) ?? []).filter((tick) => tick.epoch >= entry.entryEpoch);
  const unlock = leaderPath.find((tick) => tick.rate < 29.5) ?? null;

  const at = (seconds) => walk.find((tick) => tick.epoch >= entry.entryEpoch + seconds)?.move ?? null;

  return {
    ...entry,
    at,
    close: walk.length > 0 ? walk[walk.length - 1].move : null,
    drawdown: walk.length > 0 ? Math.min(...walk.map((tick) => tick.move)) : null,
    lockedMove: walk.some((tick) => tick.rate >= 29.5) ? moveFrom(entry.entryRate, 29.9) : null,
    peak: walk.length > 0 ? Math.max(...walk.map((tick) => tick.move)) : null,
    ticks: walk.length,
    unlockMove: unlock ? (walk.find((tick) => tick.epoch >= unlock.epoch)?.move ?? null) : null
  };
}).filter((entry) => entry.ticks > 1);

/*
 * 대조군. 같은 분에 비슷하게 올라 있던, 상한가 테마와 무관한 종목입니다.
 * ±3%p로 좁히는 이유는 +24%와 +12%가 그 뒤 다르게 움직이기 때문입니다.
 */
const lockedThemes = new Map();

for (const lock of locks) {
  const set = lockedThemes.get(lock.d) ?? new Set();

  for (const theme of themesOf.get(lock.symbol) ?? []) set.add(theme);
  lockedThemes.set(lock.d, set);
}

function isTainted(day, symbol) {
  const themes = lockedThemes.get(day);

  if (!themes) return false;

  for (const theme of themesOf.get(symbol) ?? []) {
    if (themes.has(theme)) return true;
  }

  return false;
}

const controls = [];

for (const entry of measured) {
  for (const [key, path] of paths) {
    const [day, symbol] = key.split("|");

    if (day !== entry.d || symbol === entry.symbol || symbol === entry.leader) continue;
    if (isTainted(day, symbol)) continue;

    const rate = rateAt(day, symbol, entry.entryEpoch);

    if (rate === null || Math.abs(rate - entry.entryRate) > 3 || rate >= 29.5) continue;

    const after = path.filter((tick) => tick.epoch >= entry.entryEpoch);

    if (after.length < 2) continue;

    controls.push(moveFrom(rate, after[after.length - 1].rate));
  }
}

const days = new Set(measured.map((entry) => entry.d));

console.log(`\n짝꿍매매 · 간격 ${maxGap}%p 이내에서 진입 · ${measured.length}건 · ${days.size}개 장`);
console.log("1등주가 상한가에 잠긴 뒤, 2등주가 처음 그 간격 안으로 들어온 순간이 진입입니다.");

console.log("\n[1] 진입 → 마감");
report("짝", measured.map((entry) => entry.close));
report("  대조군 (같은 분 비슷한 상승)", controls);

console.log("\n[2] 청산 시각");

for (const minutes of [5, 10, 15, 30, 60]) {
  report(`  +${minutes}분`, measured.map((entry) => entry.at(minutes * 60)));
}

report("  마감", measured.map((entry) => entry.close));

console.log("\n[3] 되돌림");

const drawdowns = measured.map((entry) => entry.drawdown).filter((x) => x !== null).sort((a, b) => a - b);
const quantile = (q) => drawdowns[Math.min(drawdowns.length - 1, Math.floor(drawdowns.length * q))];

if (drawdowns.length > 0) {
  console.log(`  최악 ${pct(drawdowns[0])} · 하위10% ${pct(quantile(0.1))}` +
    ` · 중앙 ${pct(quantile(0.5))} · 상위10% ${pct(quantile(0.9))}`);

  for (const stop of [-2, -3, -5]) {
    const hit = measured.filter((entry) => entry.drawdown !== null && entry.drawdown <= stop);

    console.log(`  ${stop}% 손절선  ${String(hit.length).padStart(3)}건 (${(hit.length / measured.length * 100).toFixed(0)}%)`);
  }
}

console.log("\n[4] 간격을 더 좁히면");

for (const [low, high] of [[0, 2], [2, 4], [4, 6]]) {
  report(`  ${low}~${high}%p`, measured.filter((entry) => entry.gap >= low && entry.gap < high)
    .map((entry) => entry.close));
}

report("  음수 (2등주가 앞섬)", measured.filter((entry) => entry.gap < 0).map((entry) => entry.close));

console.log("\n[5] 최고점 · 2등주 상한가 · 1등주 풀림");
report("최고점 (완전예지)", measured.map((entry) => entry.peak));

const locked2 = measured.filter((entry) => entry.lockedMove !== null);

console.log(`  2등주도 상한가에 닿음 ${locked2.length}건 (${(locked2.length / measured.length * 100).toFixed(0)}%)` +
  `  그 자리 평균 ${stats(locked2.map((entry) => entry.lockedMove))?.mean.toFixed(2) ?? "-"}%`);

const unlocked = measured.filter((entry) => entry.unlockMove !== null);

report("1등주 풀린 순간", unlocked.map((entry) => entry.unlockMove));
report("  그 신호의 마감", unlocked.map((entry) => entry.close));
report("안 풀린 신호의 마감", measured.filter((entry) => entry.unlockMove === null).map((entry) => entry.close));

console.log("\n[6] 진입 목록");
console.log("  날짜        시각   2등주    진입    간격    마감     최고     되돌림");

for (const entry of measured) {
  console.log(`  ${entry.d}  ${entry.entryTime}  ${entry.symbol}` +
    `${entry.entryRate.toFixed(1).padStart(7)}%${entry.gap.toFixed(1).padStart(7)}%p` +
    `${pct(entry.close ?? 0).padStart(8)}${pct(entry.peak ?? 0).padStart(9)}${pct(entry.drawdown ?? 0).padStart(9)}`);
}

process.exit(0);
