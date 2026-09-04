import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 주도 테마가 몇 시에 굳는가.
 *
 *   node scripts/measure-theme-settle.mjs
 *
 * 사용자 관찰(2026-09-04): "09시 20~30분 정도 되면 주도하는 게 달라질 수도 있다."
 *
 * 어제 잰 것이 09:30 한 시각뿐이었고 1위 적중이 12번 중 1번이었습니다. 규칙이
 * 나쁜 것인지 **시각이 이른 것인지** 구분이 안 됐습니다. 개장 직후는 동시호가
 * 잔여와 갭 조정이 섞여 순위가 흔들리므로, 이르면 못 맞히는 게 당연합니다.
 *
 * 그래서 시각을 여러 개 놓고 같은 질문을 반복합니다 -- **그 시각의 1위가 그날의
 * 주도였는가**, 그리고 **그때 들어갔으면 얼마나 남아 있었는가.** 둘은 반대로
 * 움직입니다. 늦게 고를수록 잘 맞히지만 남은 것이 없습니다. 쓸 수 있는 시각이
 * 있다면 그 둘이 교차하는 자리입니다.
 *
 * 정답은 마감 시점 초과가 가장 큰 테마입니다(회원 4종목 이상). 1위 선정에는 그
 * 시각까지의 정보만 씁니다 -- 문턱을 넘은 회원 **비율**로 매깁니다. 회원 수로
 * 세면 2차전지·원자력발전처럼 큰 테마가 매일 1위가 되는 것을 어제 확인했습니다.
 *
 * **[[ranking-keyhole-finding]] 주의.** 모집단이 거래대금 순위라 종목이 순위에
 * 들어와야 보입니다. 이른 시각일수록 관측 자체가 얇습니다.
 */

const config = readConfig();
const moveFloor = 5;
const minMembers = 3;
const clocks = ["09:05", "09:10", "09:20", "09:30", "10:00", "10:30", "11:00", "13:00", "14:00"];
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

const byDay = new Map();

for (const row of ticks) {
  const day = byDay.get(row.d) ?? new Map();
  const at = day.get(row.t) ?? new Map();

  at.set(row.symbol, Number(row.rate));
  day.set(row.t, at);
  byDay.set(row.d, day);
}

/*
 * 통과한 테마들 중 **회원이 겹치는 것끼리 하나로 묶습니다.**
 *
 * 테마 하나를 단위로 잡으면 회원 넷짜리 테마가 셋만 올라도 75%로 1위가 되고,
 * 그런 테마가 하루 종일 돌아가며 1위를 차지합니다(평균 5.9번 교체). 그런데
 * 사람이 "주도"라고 부르는 것은 테마 하나가 아니라 **같이 도는 덩어리**입니다 --
 * 2026-09-04 암호화폐가 가상화폐·스테이블코인·STO·전자결제 넷으로 동시에 떴고,
 * 09-03 철강도 철강 중소형·강관업체·남북러 가스관 셋이었습니다.
 *
 * 사전 전체를 미리 군집화하지 않고 **그 시각 통과한 것들 안에서만** 묶습니다.
 * 전체를 묶으면 single linkage가 약한 고리 하나로 무관한 테마를 잇습니다
 * ([[pair-persistence-track]]의 설계 결정과 같은 이유).
 *
 * 겹침 문턱은 **회원 2종목 이상이면서 작은 쪽의 25% 이상**입니다. 한 종목만
 * 겹치는 것으로 잇지 않는 것이 사슬을 막는 자리입니다.
 */
function mergeOverlapping(passing) {
  const parent = passing.map((_, at) => at);
  const find = (at) => (parent[at] === at ? at : (parent[at] = find(parent[at])));

  for (let left = 0; left < passing.length; left += 1) {
    for (let right = left + 1; right < passing.length; right += 1) {
      const a = new Set(passing[left].rows.map((row) => row.symbol));
      const b = passing[right].rows.map((row) => row.symbol);
      const shared = b.filter((symbol) => a.has(symbol)).length;
      const smaller = Math.min(a.size, b.length);

      if (shared >= 2 && shared >= smaller * 0.25) parent[find(left)] = find(right);
    }
  }

  const groups = new Map();

  for (let at = 0; at < passing.length; at += 1) {
    const key = find(at);
    const held = groups.get(key) ?? { names: [], rows: new Map() };

    held.names.push(passing[at].theme);
    for (const row of passing[at].rows) held.rows.set(row.symbol, row.rate);
    groups.set(key, held);
  }

  return [...groups.values()].map((held) => ({
    rows: [...held.rows].map(([symbol, rate]) => ({ rate, symbol })),
    theme: held.names.sort()[0] + (held.names.length > 1 ? ` 외 ${held.names.length - 1}` : "")
  }));
}

/** 그 시각 상태에서 테마별로 묶습니다. */
function group(state) {
  const grouped = new Map();

  for (const [symbol, rate] of state) {
    for (const theme of themesOf.get(symbol) ?? []) {
      const held = grouped.get(theme) ?? [];

      held.push({ rate, symbol });
      grouped.set(theme, held);
    }
  }

  return grouped;
}

const tally = new Map(clocks.map((clock) => [clock, { after: [], days: 0, hits: 0 }]));
const changes = [];

for (const [day, minutes] of [...byDay].sort()) {
  const times = [...minutes.keys()].sort();
  const last = minutes.get(times[times.length - 1]);

  if (!last) continue;

  /*
   * 정답 -- 마감 시점 초과가 가장 큰 **묶음**.
   *
   * 정답과 1위를 같은 단위로 재야 비교가 성립합니다. 마감에도 같은 통과 규칙을
   * 걸고 겹치는 것끼리 묶은 뒤, 그중 초과가 가장 큰 덩어리를 그날의 주도로 봅니다.
   */
  const marketClose = [...last.values()].reduce((a, b) => a + b, 0) / last.size;
  const closingPassing = [];

  for (const [theme, rows] of group(last)) {
    if (rows.filter((row) => row.rate >= moveFloor).length >= minMembers) {
      closingPassing.push({ rows, theme });
    }
  }

  let answer = null;

  for (const held of mergeOverlapping(closingPassing)) {
    if (held.rows.length < 4) continue;

    const excess = held.rows.reduce((a, b) => a + b.rate, 0) / held.rows.length - marketClose;

    if (!answer || excess > answer.excess) answer = { excess, theme: held.theme };
  }

  if (!answer) continue;

  const picks = [];

  for (const clock of clocks) {
    const at = times.find((time) => time >= clock);

    if (!at) continue;

    const state = minutes.get(at);
    const passing = [];

    for (const [theme, rows] of group(state)) {
      if (rows.filter((row) => row.rate >= moveFloor).length >= minMembers) {
        passing.push({ rows, theme });
      }
    }

    if (passing.length === 0) {
      picks.push({ clock, theme: null });
      continue;
    }

    // 겹치는 테마를 하나로 본 뒤 순위를 매깁니다.
    const merged = mergeOverlapping(passing).map((held) => ({
      ...held,
      share: held.rows.filter((row) => row.rate >= moveFloor).length / held.rows.length
    }));

    merged.sort((a, b) => b.share - a.share);

    const top = merged[0];
    const moves = top.rows.map((row) => {
      const end = last.get(row.symbol);

      return end === undefined ? null : ((100 + end) / (100 + row.rate) - 1) * 100;
    }).filter((value) => value !== null);
    const slot = tally.get(clock);

    slot.days += 1;
    if (top.theme === answer.theme) slot.hits += 1;
    if (moves.length > 0) slot.after.push(moves.reduce((a, b) => a + b, 0) / moves.length);

    picks.push({ clock, theme: top.theme });
  }

  changes.push({ answer: answer.theme, day, picks });
}

console.log(`\n주도 테마가 몇 시에 굳는가 · ${changes.length}개 장`);
console.log("1위는 그 시각까지의 정보만으로 고릅니다(문턱을 넘은 회원 비율). 정답은 마감 기준입니다.\n");
console.log("  시각     적중       그때 들어갔으면 마감까지");

for (const clock of clocks) {
  const slot = tally.get(clock);

  if (slot.days === 0) continue;

  const after = slot.after.length > 0
    ? slot.after.reduce((a, b) => a + b, 0) / slot.after.length
    : null;

  console.log(`  ${clock}   ${String(slot.hits).padStart(2)}/${String(slot.days).padEnd(2)}` +
    ` (${String(Math.round(100 * slot.hits / slot.days)).padStart(3)}%)   ${pct(after).padStart(7)}`);
}

/*
 * 1위가 실제로 몇 번 바뀌는지. 적중률만 보면 "이르면 못 맞힌다"까지만 알 수
 * 있는데, 사용자가 말한 것은 **주도 자체가 갈아탄다**는 것입니다.
 */
console.log("\n[1위가 바뀐 횟수] 09:05 → 14:00 사이\n");

let flips = 0;
let settled = 0;

for (const row of changes) {
  const seen = row.picks.filter((pick) => pick.theme);
  let count = 0;

  for (let at = 1; at < seen.length; at += 1) {
    if (seen[at].theme !== seen[at - 1].theme) count += 1;
  }

  flips += count;

  // 마지막으로 바뀐 시각 -- 그 뒤로는 안 바뀌었다는 뜻입니다.
  let lastChange = null;

  for (let at = seen.length - 1; at > 0; at -= 1) {
    if (seen[at].theme !== seen[at - 1].theme) { lastChange = seen[at].clock; break; }
  }

  if (lastChange === null) settled += 1;

  console.log(`  ${row.day}  ${count}번 바뀜` +
    (lastChange ? ` · 마지막 변경 ${lastChange}` : " · 처음부터 고정") +
    `   정답 ${String(row.answer).slice(0, 18)}`);
}

console.log(`\n  평균 ${(flips / changes.length).toFixed(1)}번 · 처음부터 고정된 날 ${settled}/${changes.length}`);
console.log("");
process.exit(0);
