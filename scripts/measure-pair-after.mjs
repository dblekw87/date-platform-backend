import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 애프터마켓 짝꿍 — 종가에 사는 것보다 나은가.
 *
 *   node scripts/measure-pair-after.mjs [--gap 6]
 *
 * 정규장 짝꿍은 성립하지 않았습니다(`measure-pair-entry.mjs`, 314건 −1.47%).
 * 애프터마켓은 성격이 다릅니다 -- 15:40~20:00은 **장중에 팔 수 없는** 구간이라
 * 스캘핑이 아니고, 출구는 익일 시가입니다. 그런데 값이 있다고 확인된 매매가
 * 정확히 그 구간을 건너뜁니다: 종가 매수 · 익일 시가 매도로 밀착 612건 +5.55%p
 * ([[pair-trade-verdict-kr]]).
 *
 * 그래서 물음은 하나로 좁혀집니다. **종가에 사는 대신 애프터마켓에 사면 다른가.**
 * 같은 밤을 사는 것이고 진입 시각만 다릅니다.
 *
 * 애프터마켓 등락률이 정규장과 같은 기준(전일 종가)인 것은 확인했습니다 --
 * 2026-09-01 254종목에서 첫 애프터 표본과 그날 종가 등락률의 평균 차이가
 * 0.178%p이고 1%p를 넘는 것이 2종목뿐입니다.
 *
 * **모집단이 전 종목이 아닙니다.** 애프터마켓 표본은 그날의 이름들만 따라갑니다
 * (`collector.mjs`의 sampleAfterHours, ranked 없음). 대조군도 그 안에서만 만들 수
 * 있으므로 "그날 순위권에 있던 다른 종목"이지 "시장 전체"가 아닙니다.
 */

const config = readConfig();
const maxGap = Number(process.argv.find((word, at) => process.argv[at - 1] === "--gap") ?? 6);
const num = (value) => (value === null || value === undefined ? null : Number(value));
const pct = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

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
    console.log(`  ${label.padEnd(26)}     0건  -`);

    return;
  }

  console.log(`  ${label.padEnd(26)} ${String(s.count).padStart(4)}건  평균 ${pct(s.mean).padStart(8)}` +
    `  중앙 ${pct(s.median).padStart(8)}  상회 ${s.win.toFixed(0).padStart(3)}%  최악 ${pct(s.worst).padStart(8)}`);
}

const { rows: tickRows } = await query(config, `
  SELECT DISTINCT ON (session_date, symbol, date_trunc('minute', observed_at))
         session_date::text AS d, symbol, change_rate,
         extract(epoch FROM observed_at) AS epoch,
         to_char(observed_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS t
    FROM market_price_samples
   WHERE market = 'KR' AND source = 'kis:nxt:after' AND change_rate IS NOT NULL
   ORDER BY session_date, symbol, date_trunc('minute', observed_at), observed_at DESC
`);

const { rows: memberRows } = await query(config, `
  SELECT DISTINCT symbol, theme_name
    FROM kr_theme_membership
   WHERE theme_name !~ '(밸류업|기업인수목적|신규상장|리츠|지주사)'
`);

/*
 * 밤을 넘기므로 일봉이 필요합니다. 종가 매수와 비교하려면 그날 종가 등락률도
 * 같이 있어야 합니다.
 */
const { rows: barRows } = await query(config, `
  WITH bars AS (
    SELECT symbol, session_date, close,
           lag(close) OVER w AS prev_close,
           lead(open) OVER w AS next_open,
           lead(close) OVER w AS next_close
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  )
  SELECT symbol, session_date::text AS d,
         CASE WHEN prev_close > 0 AND close > 0 THEN (close / prev_close - 1) * 100 END AS close_rate,
         CASE WHEN prev_close > 0 AND next_open > 0 THEN (next_open / prev_close - 1) * 100 END AS next_open_rate,
         CASE WHEN prev_close > 0 AND next_close > 0 THEN (next_close / prev_close - 1) * 100 END AS next_close_rate
    FROM bars
`);

const bars = new Map(barRows.map((row) => [`${row.d}|${row.symbol}`, row]));
const themesOf = new Map();
const membersOf = new Map();

for (const row of memberRows) {
  const own = themesOf.get(row.symbol) ?? new Set();

  own.add(row.theme_name);
  themesOf.set(row.symbol, own);

  const list = membersOf.get(row.theme_name) ?? [];

  list.push(row.symbol);
  membersOf.set(row.theme_name, list);
}

const paths = new Map();

for (const row of tickRows) {
  const key = `${row.d}|${row.symbol}`;
  const path = paths.get(key) ?? [];

  path.push({ epoch: num(row.epoch), rate: num(row.change_rate), t: row.t });
  paths.set(key, path);
}

for (const path of paths.values()) path.sort((a, b) => a.epoch - b.epoch);

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

/** 애프터마켓에서 상한가에 잠겨 있는 순간이 있는 종목. */
const locks = [];

for (const [key, path] of paths) {
  const [d, symbol] = key.split("|");
  const first = path.find((tick) => tick.rate >= 29.5);

  if (first) locks.push({ d, lockEpoch: first.epoch, symbol });
}

const entries = [];

for (const lock of locks) {
  const candidates = new Set();

  for (const theme of themesOf.get(lock.symbol) ?? []) {
    for (const symbol of membersOf.get(theme) ?? []) {
      if (symbol !== lock.symbol) candidates.add(symbol);
    }
  }

  for (const symbol of candidates) {
    const path = paths.get(`${lock.d}|${symbol}`);

    if (!path) continue;

    for (const tick of path) {
      if (tick.epoch < lock.lockEpoch) continue;

      const leaderRate = rateAt(lock.d, lock.symbol, tick.epoch);

      if (leaderRate === null) continue;

      const gap = leaderRate - tick.rate;

      // 이미 상한가인 2등주는 살 수 없습니다.
      if (gap > maxGap || tick.rate >= 29.5) continue;

      entries.push({
        d: lock.d, entryEpoch: tick.epoch, entryRate: tick.rate, entryTime: tick.t,
        gap, leader: lock.symbol, symbol
      });
      break;
    }
  }
}

const best = new Map();

for (const entry of entries) {
  const key = `${entry.d}|${entry.symbol}`;
  const held = best.get(key);

  if (!held || entry.gap < held.gap) best.set(key, entry);
}

const measured = [...best.values()].map((entry) => {
  const bar = bars.get(`${entry.d}|${entry.symbol}`);
  const path = (paths.get(`${entry.d}|${entry.symbol}`) ?? []).filter((tick) => tick.epoch >= entry.entryEpoch);
  const nextOpen = num(bar?.next_open_rate);
  const closeRate = num(bar?.close_rate);

  return {
    ...entry,
    // 애프터 마지막 값. 팔 수는 없고, 밤사이 어디까지 갔는지의 표시입니다.
    afterLast: path.length > 0 ? moveFrom(entry.entryRate, path[path.length - 1].rate) : null,
    // 종가에 샀다면. 같은 밤을 사는 다른 진입입니다.
    closeBuy: closeRate === null || nextOpen === null ? null : moveFrom(closeRate, nextOpen),
    nextClose: num(bar?.next_close_rate) === null ? null : moveFrom(entry.entryRate, num(bar.next_close_rate)),
    nextOpen: nextOpen === null ? null : moveFrom(entry.entryRate, nextOpen),
    // 애프터 진입가가 종가보다 싼가 비싼가. 이 매매의 전부일 수 있습니다.
    premium: closeRate === null ? null : moveFrom(closeRate, entry.entryRate)
  };
}).filter((entry) => entry.nextOpen !== null).sort((a, b) => (a.d === b.d ? a.entryEpoch - b.entryEpoch : a.d < b.d ? -1 : 1));

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
  for (const key of paths.keys()) {
    const [day, symbol] = key.split("|");

    if (day !== entry.d || symbol === entry.symbol || symbol === entry.leader) continue;
    if (isTainted(day, symbol)) continue;

    const rate = rateAt(day, symbol, entry.entryEpoch);
    const bar = bars.get(key);

    if (rate === null || rate >= 29.5 || Math.abs(rate - entry.entryRate) > 3) continue;
    if (!bar || num(bar.next_open_rate) === null) continue;

    controls.push(moveFrom(rate, num(bar.next_open_rate)));
  }
}

const days = new Set(measured.map((entry) => entry.d));

console.log(`\n애프터마켓 짝꿍 · 간격 ${maxGap}%p 이내 · ${measured.length}건 · ${days.size}개 장`);
console.log("15:40~20:00에 1등주가 잠긴 뒤 2등주가 간격 안으로 들어온 순간이 진입입니다.");
console.log("장중에 팔 수 없는 구간이라 출구는 익일 시가입니다.\n");

console.log("[1] 애프터 진입 → 익일 시가");
report("짝", measured.map((entry) => entry.nextOpen));
report("  대조군 (같은 분 비슷한 상승)", controls);

console.log("\n[2] 같은 밤을 종가에 샀다면");
report("종가 매수 → 익일 시가", measured.map((entry) => entry.closeBuy));
report("  애프터 진입가 − 종가", measured.map((entry) => entry.premium));

console.log("\n[3] 더 들고 가면");
report("익일 종가까지", measured.map((entry) => entry.nextClose));
report("애프터 마지막 값 (못 팜)", measured.map((entry) => entry.afterLast));

console.log("\n[4] 간격별 · 익일 시가");

for (const [low, high] of [[0, 2], [2, 4], [4, 6]]) {
  report(`  ${low}~${high}%p`, measured.filter((entry) => entry.gap >= low && entry.gap < high)
    .map((entry) => entry.nextOpen));
}

report("  음수 (2등주가 앞섬)", measured.filter((entry) => entry.gap < 0).map((entry) => entry.nextOpen));

console.log("\n[5] 목록");
console.log("  날짜        시각   2등주    진입    간격   프리미엄   익일시가   종가매수");

for (const entry of measured) {
  console.log(`  ${entry.d}  ${entry.entryTime}  ${entry.symbol}` +
    `${entry.entryRate.toFixed(1).padStart(7)}%${entry.gap.toFixed(1).padStart(6)}%p` +
    `${pct(entry.premium ?? 0).padStart(9)}${pct(entry.nextOpen ?? 0).padStart(10)}` +
    `${pct(entry.closeBuy ?? 0).padStart(10)}`);
}

process.exit(0);
