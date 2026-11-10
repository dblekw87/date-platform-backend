import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 시장경보 지정 다음 날 -- 모든 종목, 모든 지정.
 *
 *   node scripts/measure-caution-all.mjs
 *
 * measure-caution-next-day.mjs는 가격 조건 자리(상한가 또는 5일 +55%)만 봤습니다.
 * 2026-11-10 사용자: "우선주뿐 아니라 다른 개별 종목도 포함해서 지정 다음날 어떻게
 * 되는지 다 알아봐야 돼." 그래서 지정마다 비교 대상을 맞춥니다:
 *
 *   사건   그날(D) 경보가 한 단계 오름 -- 00 → 01(투자주의), 01 → 02·03(투자경고·위험).
 *          D+1에 붙은 경보는 D 저녁 공표분입니다(kr_symbol_flags는 그날 상태).
 *   대조   같은 D, 같은 출발 경보에서 안 오른 종목 중 **D 등락 칸과 5일 등락 칸이 같은 것**.
 *          지정 종목은 대개 많이 오른 종목이라, 그냥 비교하면 "오른 다음날"을 재게 됩니다.
 *   결과   D+1 시가 갭, D+1 종가, D+3 종가 (모두 D 종가 대비 %). 칸별 차이를 건수로 가중합니다.
 *
 * 경보 표는 08/19~이고 수집기가 본 종목만 있습니다(순위권 밖이면 빠짐).
 */
const config = readConfig();

const { rows } = await query(config, `
  WITH b AS (
    SELECT symbol, session_date d, open::float8 o, close::float8 c,
           lag(close::float8) OVER w pc, lag(close::float8, 5) OVER w c5,
           lead(session_date) OVER w d1, lead(open::float8) OVER w o1,
           lead(close::float8) OVER w c1, lead(close::float8, 3) OVER w c3
      FROM kr_daily_bars WHERE session_date >= '2026-08-01'
    WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  )
  SELECT b.symbol, b.d::text d, p.market_warn w0, n.market_warn w1,
         (b.c / b.pc - 1) * 100 r, (b.c / b.c5 - 1) * 100 r5,
         (b.o1 / b.c - 1) * 100 gap, (b.c1 / b.c - 1) * 100 close1, (b.c3 / b.c - 1) * 100 close3
    FROM b
    JOIN kr_symbol_flags p ON p.symbol = b.symbol AND p.session_date = b.d
    JOIN kr_symbol_flags n ON n.symbol = b.symbol AND n.session_date = b.d1
   WHERE b.pc > 0 AND b.c5 > 0 AND b.o1 > 0 AND b.c1 > 0
     AND p.market_warn IN ('00', '01')`);

const pref = (symbol) => /^[0-9]{5}[579KL]$/.test(symbol);
const rBucket = (r) => (r >= 29.5 ? "상한가" : r >= 15 ? "+15~29" : r >= 5 ? "+5~15" : r >= -5 ? "±5" : "−5 아래");
const r5Bucket = (r5) => (r5 >= 60 ? "5일 60+" : r5 >= 30 ? "5일 30~60" : r5 >= 10 ? "5일 10~30" : "5일 10 아래");
const raised = (row) => (row.w0 === "00" ? ["01", "02", "03"].includes(row.w1) : ["02", "03"].includes(row.w1));
const mean = (list) => list.reduce((s, v) => s + v, 0) / list.length;
const med = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const f = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "-");

/*
 * 칸(D, 출발 경보, 등락 칸, 5일 칸)마다 지정 평균 − 대조 평균, 지정 건수로 가중.
 * 같은 날로 묶는 것은 그날 시장을 같이 빼기 위해서입니다.
 */
function matched(events, pool, field) {
  const cells = new Map();

  for (const row of pool) {
    if (row[field] == null) continue;
    const key = `${row.d}|${row.w0}|${rBucket(row.r)}|${r5Bucket(row.r5)}`;

    if (!cells.has(key)) cells.set(key, { ctl: [], ev: [] });
    cells.get(key)[raised(row) ? "ev" : "ctl"].push(Number(row[field]));
  }

  let weight = 0;
  let sum = 0;
  let used = 0;

  for (const event of events) {
    if (event[field] == null) continue;
    const cell = cells.get(`${event.d}|${event.w0}|${rBucket(event.r)}|${r5Bucket(event.r5)}`);

    if (!cell || !cell.ctl.length) continue;
    sum += Number(event[field]) - mean(cell.ctl);
    weight += 1;
    used += 1;
  }

  return { diff: weight ? sum / weight : NaN, used };
}

function report(title, scope) {
  const pool = rows.filter(scope);
  const events = pool.filter(raised);

  if (!events.length) return console.log(`${title} | 0`);
  const g = matched(events, pool, "gap");
  const c1 = matched(events, pool, "close1");
  const c3 = matched(events, pool, "close3");
  const tail = (list) => `${Math.round((100 * list.filter((v) => v <= -10).length) / list.length)}%`;

  console.log([
    title,
    events.length,
    `${f(med(events.map((r) => Number(r.gap))))} / ${f(med(events.map((r) => Number(r.close1))))}`,
    tail(events.map((r) => Number(r.close1))),
    `${f(g.diff)} (${g.used})`,
    `${f(c1.diff)}`,
    `${f(c3.diff)} (${c3.used})`
  ].join(" | "));
}

console.log("구분 | 지정 건수 | 다음날 시가갭/종가 중앙 | 다음 종가 −10%↓ | 대조 대비 갭 차(맞춘 건수) | 대조 대비 D+1 종가 차 | 대조 대비 D+3 종가 차(건수)");

console.log("\n== 투자주의 신규(00 → 주의 이상)");
report("전체", (r) => r.w0 === "00");
report("보통주", (r) => r.w0 === "00" && !pref(r.symbol));
report("우선주", (r) => r.w0 === "00" && pref(r.symbol));
for (const b of ["상한가", "+15~29", "+5~15", "±5", "−5 아래"]) report(`그날 ${b}`, (r) => r.w0 === "00" && rBucket(r.r) === b);
report("가격 조건 없음(그날 +15% 미만·5일 +30% 미만)", (r) => r.w0 === "00" && r.r < 15 && r.r5 < 30);

console.log("\n== 투자경고 승격(주의 → 경고·위험)");
report("전체", (r) => r.w0 === "01");
report("보통주", (r) => r.w0 === "01" && !pref(r.symbol));
report("우선주", (r) => r.w0 === "01" && pref(r.symbol));
report("그날 상한가", (r) => r.w0 === "01" && r.r >= 29.5);
report("그날 상한가 아님", (r) => r.w0 === "01" && r.r < 29.5);

process.exit(0);
