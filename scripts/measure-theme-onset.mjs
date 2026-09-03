import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 그날의 주도 테마를 몇 시에 알 수 있었고, 그때 얼마나 남아 있었는가.
 *
 *   node scripts/measure-theme-onset.mjs [--members 3] [--floor 5]
 *
 * 사용자가 2026-09-03 09시대에 철강을 주도로 짚었고, 우리 데이터는 물어봤을 때만
 * 확인했습니다. 알림을 붙이기 전에 재야 할 것은 두 가지입니다 -- **몇 시에
 * 잡히는가**, 그리고 **그 시각 이후로 얼마나 더 가는가**. 늦게 잡히면 그 알림은
 * 신호가 아니라 통지입니다.
 *
 * 감지 규칙은 사람이 눈으로 하는 것과 같게 둡니다: 한 테마에서 관측된 회원 중
 * `--floor`% 이상 오른 것이 `--members`개가 되는 첫 순간.
 *
 * **정답은 그날 끝나고 정합니다** -- 마감 시점에 평균 초과가 가장 큰 테마(회원
 * 4종목 이상). 그 테마를 감지 규칙이 언제 지목했는지 봅니다. 지목 못 한 날도
 * 셉니다. 사후에 정한 정답으로 감지 시각만 재는 것이라, 이 값은 "규칙이 맞았나"가
 * 아니라 "맞았을 때 얼마나 일렀나"입니다.
 *
 * **[[ranking-keyhole-finding]] 주의.** 모집단이 거래대금 순위라 종목이 순위에
 * 들어와야 보입니다. 그래서 "몇 시에 잡히는가"는 우리 관측의 한계까지 포함한
 * 값이고, 실제 시세 시작보다 늦습니다. 다만 알림이 쓸 수 있는 것도 이 관측뿐이라,
 * 재는 값으로는 이게 맞습니다.
 */

const config = readConfig();
const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);

  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const minMembers = flag("members", 3);
const moveFloor = flag("floor", 5);
const pct = (value) => (value === null ? "  -  " : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`);

const { rows: ticks } = await query(config, `
  SELECT DISTINCT ON (session_date, symbol, date_trunc('minute', observed_at))
         session_date::text AS d, symbol, change_rate AS rate,
         to_char(observed_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS t
    FROM market_price_samples
   WHERE market = 'KR' AND source LIKE 'kis:krx%' AND change_rate IS NOT NULL
     AND (observed_at AT TIME ZONE 'Asia/Seoul')::time BETWEEN '09:00' AND '15:30'
   ORDER BY session_date, symbol, date_trunc('minute', observed_at), observed_at DESC
`);

const { rows: memberRows } = await query(config, `
  SELECT DISTINCT symbol, theme_name FROM kr_theme_membership
   WHERE theme_name !~ '(밸류업|기업인수목적|신규상장|리츠|지주사)'
`);

const themesOf = new Map();

for (const row of memberRows) {
  const own = themesOf.get(row.symbol) ?? new Set();

  own.add(row.theme_name);
  themesOf.set(row.symbol, own);
}

/* 날 → 시각 → 종목 → 등락률 */
const byDay = new Map();

for (const row of ticks) {
  const day = byDay.get(row.d) ?? new Map();
  const at = day.get(row.t) ?? new Map();

  at.set(row.symbol, Number(row.rate));
  day.set(row.t, at);
  byDay.set(row.d, day);
}

const results = [];

for (const [day, minutes] of [...byDay].sort()) {
  const times = [...minutes.keys()].sort();
  const last = minutes.get(times[times.length - 1]);
  // 마감 시점 상태로 그날의 정답을 정합니다.
  const marketClose = [...last.values()].reduce((a, b) => a + b, 0) / last.size;
  const closing = new Map();

  for (const [symbol, rate] of last) {
    for (const theme of themesOf.get(symbol) ?? []) {
      const held = closing.get(theme) ?? [];

      held.push(rate);
      closing.set(theme, held);
    }
  }

  let leader = null;

  for (const [theme, rates] of closing) {
    if (rates.length < 4) continue;

    const excess = rates.reduce((a, b) => a + b, 0) / rates.length - marketClose;

    if (!leader || excess > leader.excess) leader = { excess, members: rates.length, theme };
  }

  if (!leader) continue;

  // 그 테마를 감지 규칙이 처음 지목한 시각.
  let detectedAt = null;
  let detectedRates = null;

  for (const time of times) {
    const state = minutes.get(time);
    const rates = [];

    for (const [symbol, rate] of state) {
      if ((themesOf.get(symbol) ?? new Set()).has(leader.theme)) rates.push({ rate, symbol });
    }

    if (rates.filter((row) => row.rate >= moveFloor).length >= minMembers) {
      detectedAt = time;
      detectedRates = new Map(rates.map((row) => [row.symbol, row.rate]));
      break;
    }
  }

  if (!detectedAt) {
    results.push({ day, detectedAt: null, leader });
    continue;
  }

  /*
   * 지목한 순간부터 마감까지, 그 테마 회원이 평균 얼마나 더 갔는가.
   * 지목 시점에 이미 오른 것을 다시 세면 안 되므로 **그 시각 값을 기준**으로
   * 나눕니다 -- 절대 등락률이 아니라 진입가 대비입니다.
   */
  const after = [];

  for (const [symbol, rate] of detectedRates) {
    const end = last.get(symbol);

    if (end === undefined) continue;

    after.push(((100 + end) / (100 + rate) - 1) * 100);
  }

  const mean = after.length > 0 ? after.reduce((a, b) => a + b, 0) / after.length : null;
  const best = after.length > 0 ? Math.max(...after) : null;
  // 그 시각 기준 시장도 같이 움직였을 수 있으니 대조군을 뺍니다.
  const state = minutes.get(detectedAt);
  const drift = [];

  for (const [symbol, rate] of state) {
    const end = last.get(symbol);

    if (end !== undefined) drift.push(((100 + end) / (100 + rate) - 1) * 100);
  }

  const ambient = drift.length > 0 ? drift.reduce((a, b) => a + b, 0) / drift.length : 0;

  results.push({
    after: mean, ambient, best, day, detectedAt,
    leader, seen: detectedRates.size
  });
}

console.log(`\n주도 테마 감지 · ${results.length}개 장 · 규칙: 회원 ${minMembers}종목이 ${moveFloor}%↑`);
console.log("정답은 마감 시점 초과가 가장 큰 테마입니다. 감지 시각 이후 값은 그 시점 대비입니다.\n");
console.log(`${"날짜".padEnd(12)} ${"주도 테마".padEnd(26)} 감지    이후 평균   최고    대조군`);

for (const row of results) {
  console.log(`  ${row.day}  ${String(row.leader.theme).slice(0, 24).padEnd(25)}` +
    ` ${row.detectedAt ?? "못 잡음"}` +
    (row.detectedAt
      ? `  ${pct(row.after).padStart(7)} ${pct(row.best).padStart(8)} ${pct(row.ambient).padStart(8)}`
      : ""));
}

const caught = results.filter((row) => row.detectedAt);
const early = caught.filter((row) => row.detectedAt < "10:00");

if (caught.length > 0) {
  const mean = (list, key) => list.reduce((a, b) => a + b[key], 0) / list.length;

  console.log(`\n  지목 ${caught.length}/${results.length}개 장 · 그중 10시 이전 ${early.length}개`);
  console.log(`  지목 뒤 마감까지  평균 ${pct(mean(caught, "after"))} · 최고 회원 ${pct(mean(caught, "best"))}` +
    ` · 대조군 ${pct(mean(caught, "ambient"))}`);

  if (early.length > 0) {
    console.log(`  10시 이전 지목분  평균 ${pct(mean(early, "after"))} · 최고 회원 ${pct(mean(early, "best"))}` +
      ` · 대조군 ${pct(mean(early, "ambient"))}`);
  }
}

/*
 * 여기까지는 **정답을 알고 잰 값**입니다. 실시간에는 같은 규칙을 여러 테마가 동시에
 * 통과하므로, 그 순간 고를 수 있는 규칙인지 따로 봐야 합니다.
 *
 * 09:30에 통과한 테마를 전부 세고, 그중 사후 정답이 몇 위였는지, 그리고 그 시각
 * **1위를 그냥 샀다면** 어떻게 됐는지 잽니다. 1위 선정은 그 시각 정보만 씁니다 --
 * 문턱을 넘은 회원 수, 동점이면 평균 등락률.
 */
console.log("\n[실시간] 09:30에 통과한 테마를 그 자리에서 골랐다면\n");

const live = [];
/*
 * 순위를 무엇으로 매길 것인가.
 *
 * 회원 수로 세면 2차전지·원자력발전처럼 회원이 많은 테마가 매일 1위가 됩니다 --
 * 실제로 12개 장에서 1위가 정답이었던 날이 하루뿐이었고 그 1위가 거의 늘
 * 저 둘이었습니다. 큰 테마의 이점을 없앤 순위들을 나란히 재봅니다.
 */
const variants = { both: [], count: [], mean: [], share: [] };

function pick(day, chosen, state, last) {
  if (!chosen) return null;

  const forward = (rows) => {
    const moves = rows.map((row) => {
      const end = last.get(row.symbol);

      return end === undefined ? null : ((100 + end) / (100 + row.rate) - 1) * 100;
    }).filter((value) => value !== null);

    return moves.length > 0 ? moves.reduce((a, b) => a + b, 0) / moves.length : null;
  };
  const drift = [...state].map(([symbol, rate]) => {
    const end = last.get(symbol);

    return end === undefined ? null : ((100 + end) / (100 + rate) - 1) * 100;
  }).filter((value) => value !== null);
  const answer = results.find((row) => row.day === day)?.leader?.theme ?? null;

  return {
    ambient: drift.length > 0 ? drift.reduce((a, b) => a + b, 0) / drift.length : 0,
    forward: forward(chosen.rows),
    hit: answer === chosen.theme,
    theme: chosen.theme
  };
}

for (const [day, minutes] of [...byDay].sort()) {
  const times = [...minutes.keys()].sort();
  const at = times.find((time) => time >= "09:30");
  const last = minutes.get(times[times.length - 1]);

  if (!at || !last) continue;

  const state = minutes.get(at);
  const grouped = new Map();

  for (const [symbol, rate] of state) {
    for (const theme of themesOf.get(symbol) ?? []) {
      const held = grouped.get(theme) ?? [];

      held.push({ rate, symbol });
      grouped.set(theme, held);
    }
  }

  const passing = [];

  for (const [theme, rows] of grouped) {
    const hot = rows.filter((row) => row.rate >= moveFloor);

    if (hot.length < minMembers) continue;

    passing.push({
      hot: hot.length,
      mean: rows.reduce((a, b) => a + b.rate, 0) / rows.length,
      rows, theme
    });
  }

  if (passing.length === 0) continue;

  passing.sort((a, b) => (b.hot === a.hot ? b.mean - a.mean : b.hot - a.hot));
  variants.count.push(pick(day, passing[0], state, last));
  // 비율: 회원 수가 아니라 **몇 %가 달리는가**. 큰 테마의 이점을 없앱니다.
  variants.share.push(pick(day, [...passing].sort((a, b) =>
    b.hot / b.rows.length - a.hot / a.rows.length)[0], state, last));
  // 평균 등락: 얼마나 세게 달리는가.
  variants.mean.push(pick(day, [...passing].sort((a, b) => b.mean - a.mean)[0], state, last));
  // 비율 × 세기. 둘 다 요구합니다.
  variants.both.push(pick(day, [...passing].sort((a, b) =>
    (b.hot / b.rows.length) * b.mean - (a.hot / a.rows.length) * a.mean)[0], state, last));

  const forward = (rows) => {
    const moves = rows.map((row) => {
      const end = last.get(row.symbol);

      return end === undefined ? null : ((100 + end) / (100 + row.rate) - 1) * 100;
    }).filter((value) => value !== null);

    return moves.length > 0 ? moves.reduce((a, b) => a + b, 0) / moves.length : null;
  };
  const drift = [...state].map(([symbol, rate]) => {
    const end = last.get(symbol);

    return end === undefined ? null : ((100 + end) / (100 + rate) - 1) * 100;
  }).filter((value) => value !== null);
  const ambient = drift.length > 0 ? drift.reduce((a, b) => a + b, 0) / drift.length : 0;
  const answer = results.find((row) => row.day === day)?.leader?.theme ?? null;
  const rank = answer ? passing.findIndex((row) => row.theme === answer) + 1 : 0;

  live.push({
    ambient, day, picked: passing[0].theme, passing: passing.length,
    rank, top: forward(passing[0].rows)
  });

  console.log(`  ${day}  통과 ${String(passing.length).padStart(2)}개 · 1위 ${String(passing[0].theme).slice(0, 20).padEnd(21)}` +
    ` 이후 ${pct(forward(passing[0].rows)).padStart(7)} (대조군 ${pct(ambient).padStart(6)})` +
    `  정답 순위 ${rank > 0 ? rank : "밖"}`);
}

if (live.length > 0) {
  const mean = (key) => live.reduce((a, b) => a + (b[key] ?? 0), 0) / live.length;
  const hit = live.filter((row) => row.rank === 1).length;

  console.log(`
  ${live.length}개 장 · 통과 테마 평균 ${mean("passing").toFixed(1)}개`);
  console.log(`  1위가 정답이었던 날 ${hit}/${live.length}`);
  console.log(`  1위를 샀다면 마감까지 ${pct(mean("top"))} · 대조군 ${pct(mean("ambient"))}`);
}

console.log("\n[순위 규칙별] 09:30에 1위를 샀다면\n");

for (const [key, label] of [["count", "회원 수"], ["share", "회원 비율"],
  ["mean", "평균 등락"], ["both", "비율 × 세기"]]) {
  const list = variants[key].filter(Boolean).filter((row) => row.forward !== null);

  if (list.length === 0) continue;

  const mean = (name) => list.reduce((a, b) => a + b[name], 0) / list.length;
  const hits = list.filter((row) => row.hit).length;

  console.log(`  ${label.padEnd(10)} 정답 적중 ${hits}/${list.length}` +
    ` · 이후 ${pct(mean("forward")).padStart(7)} · 대조군 ${pct(mean("ambient")).padStart(7)}` +
    ` · 초과 ${pct(mean("forward") - mean("ambient")).padStart(7)}`);
}

console.log("");
process.exit(0);
