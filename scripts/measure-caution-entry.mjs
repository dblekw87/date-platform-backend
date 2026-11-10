import { cautionReason } from "../src/providers/caution-watch.mjs";
import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 15:10 경보 후보에 종가로 들어가면 다음날 시가가 어떤가 -- 지정을 모르는 채로.
 *
 *   node scripts/measure-caution-entry.mjs
 *
 * 2026-11-10 사용자: "다음날 시가로 봐줘야 돼. 종베로 들어가면 다음날 시가에 파니까,
 * 종가로 들어가기 전에 알아야 되는 거지, 내가 지정받기 전에." measure-caution-all.mjs는
 * 지정이 **난 뒤**를 기준으로 갈랐습니다 -- 들어갈 때는 그걸 모릅니다. 여기서는 들어가는
 * 시각에 보이는 것(그날 가격·5일 가격·오늘 경보 상태)만으로 caution-watch.mjs의 규칙을
 * 그대로 걸고, 다음날 시가를 봅니다:
 *
 *   후보     규칙에 걸린 것 (확률 붙은 칸. 이미 경고 중인 칸은 따로)
 *   대조     같은 날, 같은 당일 등락 칸(상한가 / +15~29)인데 규칙에 안 걸린 것
 *   결과     다음날 시가 갭(D 종가 대비), 시장 동일가중 시가 갭을 뺀 초과
 *
 * 그날 값은 확정 종가로 씁니다(15:10 값과 조금 다름). 경보 표는 08/19~, 수집기가 본 종목만.
 */
const config = readConfig();

const { rows } = await query(config, `
  WITH b AS (
    SELECT symbol, session_date d, open::float8 o, close::float8 c,
           lag(close::float8) OVER w pc, lag(close::float8, 2) OVER w pc2, lag(close::float8, 5) OVER w c5,
           lead(session_date) OVER w d1, lead(open::float8) OVER w o1
      FROM kr_daily_bars WHERE session_date >= '2026-08-01'
    WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  mkt AS (SELECT d, avg(o / pc - 1) gap FROM b WHERE o > 0 AND pc > 0 GROUP BY d)
  SELECT b.symbol, b.d::text d, f.market_warn warn, n.market_warn next_warn,
         (b.c / b.pc - 1) * 100 rate, (b.pc / b.pc2 - 1) * 100 prev_rate, b.c / b.c5 - 1 five,
         (b.o1 / b.c - 1) * 100 gap, (b.o1 / b.c - 1 - m.gap) * 100 excess
    FROM b
    JOIN kr_symbol_flags f ON f.symbol = b.symbol AND f.session_date = b.d
    LEFT JOIN kr_symbol_flags n ON n.symbol = b.symbol AND n.session_date = b.d1
    JOIN mkt m ON m.d = b.d1
   WHERE b.pc > 0 AND b.pc2 > 0 AND b.c5 > 0 AND b.o1 > 0
     AND (b.c / b.pc - 1) >= 0.15`);

for (const row of rows) {
  row.reason = cautionReason({ fiveDay: Number(row.five), prevRate: Number(row.prev_rate), rate: Number(row.rate), warn: row.warn });
}

const med = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const mean = (list) => list.reduce((s, v) => s + v, 0) / list.length;
const f = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "-");

function line(label, set) {
  if (!set.length) return console.log(`${label} | 0`);
  const gaps = set.map((r) => Number(r.gap));
  const ex = set.map((r) => Number(r.excess));

  console.log([
    label, set.length,
    f(med(gaps)), f(mean(gaps)),
    f(med(ex)),
    `${Math.round((100 * gaps.filter((g) => g <= -3).length) / set.length)}%`,
    `${Math.round((100 * gaps.filter((g) => g >= 3).length) / set.length)}%`
  ].join(" | "));
}

const flagged = (r) => r.reason && r.reason.odds;
const already = (r) => r.reason && !r.reason.odds;

console.log("구분 | 건수 | 다음 시가 갭 중앙 | 평균 | 시장 대비 초과 중앙 | 갭 −3%↓ | 갭 +3%↑");
for (const [title, scope] of [["그날 상한가", (r) => r.rate >= 29.5], ["그날 +15~29%", (r) => r.rate < 29.5]]) {
  console.log(`\n== ${title}`);
  const set = rows.filter(scope);

  line("15:10 경보 후보(확률 칸)", set.filter(flagged));
  line("  └ 그날 밤 실제 지정됨", set.filter((r) => flagged(r) && r.next_warn && r.next_warn > (r.warn ?? "00")));
  line("  └ 지정 안 됨", set.filter((r) => flagged(r) && r.next_warn && !(r.next_warn > (r.warn ?? "00"))));
  line("이미 경고·위험 중", set.filter(already));
  line("후보 아님(대조)", set.filter((r) => !r.reason));
}

console.log("\n칸별 (상한가만)");
for (const label of ["2연상", "상한가 ·", "투자주의 중"]) {
  line(`  ${label}`, rows.filter((r) => r.rate >= 29.5 && flagged(r) && r.reason.label.startsWith(label)));
}

process.exit(0);
