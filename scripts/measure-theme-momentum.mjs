import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 스냅샷이 아니라 **확장 중인지**로 테마를 고르면 다른가.
 *
 *   node scripts/measure-theme-momentum.mjs [--window 15]
 *
 * 2026-09-04 09:04에는 가상화폐가 비율 1위(7/12)였는데 09:19에는 로봇이 앞섰습니다.
 * 사용자가 "09시 20~30분이면 주도가 달라질 수 있다"고 했고 그대로였습니다.
 *
 *   로봇        5%↑ 8 → 14 · 평균 +4.6 → +7.7    회원이 붙는 중
 *   가상화폐     5%↑ 6 →  7 · 평균 +7.6 → +6.9    오른 것들이 밀리는 중
 *
 * 지금까지 잰 규칙은 전부 **그 순간의 스냅샷**이었습니다. 몇 종목이 5% 넘었나,
 * 비율이 얼마인가. 위 둘은 스냅샷으로는 09:04에 가상화폐가 이기고, 방향으로는
 * 로봇이 이깁니다. 방향을 넣으면 달라지는지 봅니다.
 *
 * **적중률 대신 수익을 봅니다.** 앞선 측정에서 "그날의 주도 테마"가 정의를 조금만
 * 바꿔도 답이 통째로 바뀌는 것을 봤습니다(테마 단위 → 묶음 단위에서 8/19 패션/의류
 * → 철도, 09-02 해운 → 음식료업종). 정답이 그렇게 흔들리면 적중률은 그 정의의
 * 성질을 재는 것이지 규칙의 성질이 아닙니다. 그 시각에 사서 마감까지 얼마인가는
 * 정의와 무관합니다.
 *
 * 대조군은 **그 시각 관측된 전 종목의 같은 구간 평균**입니다. 장이 좋은 날에는
 * 무엇을 사도 오르므로 그것을 빼야 규칙의 몫이 남습니다.
 */

const config = readConfig();
const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);

  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const windowMinutes = flag("window", 15);
const moveFloor = 5;
const minMembers = 3;
const clocks = ["09:20", "09:30", "10:00", "10:30", "11:00", "13:00"];
const pct = (value) => (value === null ? "  -  " : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`);

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

const minutesBefore = (clock, back) => {
  const [hour, minute] = clock.split(":").map(Number);
  const total = hour * 60 + minute - back;

  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

const rules = ["스냅샷 비율", "종목 수 증가", "평균 상승", "증가 × 비율"];
const tally = new Map(clocks.flatMap((clock) => rules.map((rule) => [`${clock}|${rule}`, []])));
const ambientOf = new Map(clocks.map((clock) => [clock, []]));

for (const [, minutes] of [...byDay].sort()) {
  const times = [...minutes.keys()].sort();
  const last = minutes.get(times[times.length - 1]);

  if (!last) continue;

  for (const clock of clocks) {
    const at = times.find((time) => time >= clock);
    const backAt = times.filter((time) => time <= minutesBefore(clock, windowMinutes)).pop();

    if (!at || !backAt) continue;

    const state = minutes.get(at);
    const before = group(minutes.get(backAt));
    const forward = (rows) => {
      const moves = rows.map((row) => {
        const end = last.get(row.symbol);

        return end === undefined ? null : ((100 + end) / (100 + row.rate) - 1) * 100;
      }).filter((value) => value !== null);

      return moves.length > 0 ? moves.reduce((a, b) => a + b, 0) / moves.length : null;
    };
    const scored = [];

    for (const [theme, rows] of group(state)) {
      const hot = rows.filter((row) => row.rate >= moveFloor).length;

      if (hot < minMembers) continue;

      const past = before.get(theme) ?? [];
      const hotBefore = past.filter((row) => row.rate >= moveFloor).length;
      const meanNow = rows.reduce((a, b) => a + b.rate, 0) / rows.length;
      const meanBefore = past.length > 0 ? past.reduce((a, b) => a + b.rate, 0) / past.length : meanNow;

      scored.push({
        // 지난 창 대비 몇 종목이 새로 문턱을 넘었나.
        grew: hot - hotBefore,
        meanUp: meanNow - meanBefore,
        rows,
        share: hot / rows.length,
        theme
      });
    }

    if (scored.length === 0) continue;

    const drift = [...state].map(([symbol, rate]) => {
      const end = last.get(symbol);

      return end === undefined ? null : ((100 + end) / (100 + rate) - 1) * 100;
    }).filter((value) => value !== null);

    ambientOf.get(clock).push(drift.length > 0 ? drift.reduce((a, b) => a + b, 0) / drift.length : 0);

    const pick = {
      "스냅샷 비율": [...scored].sort((a, b) => b.share - a.share)[0],
      "종목 수 증가": [...scored].sort((a, b) => b.grew - a.grew || b.share - a.share)[0],
      "평균 상승": [...scored].sort((a, b) => b.meanUp - a.meanUp)[0],
      "증가 × 비율": [...scored].sort((a, b) => b.grew * b.share - a.grew * a.share || b.share - a.share)[0]
    };

    for (const rule of rules) {
      const value = forward(pick[rule].rows);

      if (value !== null) tally.get(`${clock}|${rule}`).push(value);
    }
  }
}

console.log(`\n확장 중인 테마를 고르면 다른가 · 창 ${windowMinutes}분 · ${byDay.size}개 장`);
console.log("그 시각 1위 테마의 회원을 사서 마감까지. 대조군은 그 시각 관측된 전 종목의 같은 구간.\n");
console.log(`  시각    ${rules.map((rule) => rule.padEnd(11)).join("")}대조군`);

for (const clock of clocks) {
  const ambient = ambientOf.get(clock);

  if (ambient.length === 0) continue;

  const mean = (list) => (list.length > 0 ? list.reduce((a, b) => a + b, 0) / list.length : null);
  const base = mean(ambient);

  console.log(`  ${clock}  ` + rules.map((rule) => {
    const value = mean(tally.get(`${clock}|${rule}`));

    return (value === null ? "  -  " : pct(value - base)).padEnd(11);
  }).join("") + pct(base));
}

console.log("\n  값은 대조군을 뺀 초과분입니다. 대조군 열만 절대값입니다.");
console.log("");
process.exit(0);
