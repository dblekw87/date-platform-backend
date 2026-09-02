import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 종가배팅 후보가 다음 날 실제로 어떻게 됐는지, 하루씩.
 *
 *   npm run kr:close-bet-log            최근 10개 장
 *   npm run kr:close-bet-log -- 30      최근 30개 장
 *
 * `kr_close_bet_calibration`은 1.6년치 누적 성적이고 이건 **그날 실제로 뜬 종목**의
 * 결과입니다. 둘은 다른 질문에 답합니다 -- 누적은 "이 조건에 값이 있는가",
 * 이건 "지금 내 화면에 뜨는 것이 맞고 있는가"입니다. 조건을 바꾼 뒤 좋아졌는지
 * 나빠졌는지는 이쪽으로만 답할 수 있습니다.
 *
 * 갭은 **그날 밤 시장 평균 갭을 뺀 초과분**을 같이 적습니다. 절대 갭만 보면
 * 밤이 좋았던 날의 조건이 다 좋아 보입니다 -- 우리 밤 셋의 갭상승 확률이
 * 43% / 71% / 30%였습니다.
 *
 * 청산 시각이 익일 시가인 것은 일봉에 시가밖에 없어서입니다. 실제 청산은
 * 09:05~09:10이고 34건 기준 그쪽이 조금 나았습니다(상회 74% vs 68%).
 */

const config = readConfig();
const limit = Number(process.argv.find((word) => /^\d+$/.test(word)) ?? 10);
const pct = (value, digits = 2) =>
  value === null ? "  -  " : `${value >= 0 ? "+" : ""}${Number(value).toFixed(digits)}%`;

const { rows } = await query(config, `
  WITH market AS (
    SELECT session_date, avg(open / nullif(prev, 0) - 1) * 100 AS gap
      FROM (SELECT symbol, session_date, open,
                   lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev
              FROM kr_daily_bars) t
     WHERE prev > 0 GROUP BY session_date HAVING count(*) >= 50
  ),
  days AS (
    SELECT DISTINCT session_date FROM kr_signal_outcomes WHERE kind = 'close_bet'
     ORDER BY session_date DESC LIMIT $1
  )
  SELECT o.session_date::text AS d, o.symbol, o.tier, o.entry_rate,
         b.close AS entry_price, o.next_open, o.next_close,
         (SELECT gap FROM market m WHERE m.session_date > o.session_date
           ORDER BY m.session_date LIMIT 1) AS market_gap,
         (SELECT u.name FROM kr_daily_universe u
           WHERE u.symbol = o.symbol ORDER BY u.session_date DESC LIMIT 1) AS name
    FROM kr_signal_outcomes o
    JOIN days USING (session_date)
    LEFT JOIN kr_daily_bars b ON b.symbol = o.symbol AND b.session_date = o.session_date
   WHERE o.kind = 'close_bet'
   ORDER BY o.session_date DESC, o.entry_rate DESC
`, [limit]);

if (rows.length === 0) {
  console.log("\n기록된 종가배팅 후보가 없습니다.\n");
  process.exit(0);
}

const scored = [];
// 절대 갭과 초과는 따로 셉니다. 우리가 잰 밤들이 대부분 시장 갭 -2~-3%라
// **초과는 이겨도 실제로는 갭하락으로 시작한 아침**이 흔합니다. 둘을 한 숫자로
// 뭉치면 "갭상승했나"라는 질문에 답을 못 합니다.
const absolute = [];
const byDay = new Map();

for (const row of rows) {
  const list = byDay.get(row.d) ?? [];

  list.push(row);
  byDay.set(row.d, list);
}

console.log(`\n종가배팅 결과 · ${byDay.size}개 장 · ${rows.length}건`);
console.log("초과 = 익일 시가 갭에서 그날 밤 시장 평균 갭을 뺀 값\n");

for (const [day, list] of byDay) {
  const done = [];

  console.log(`${day}  ${list.length}건`);

  for (const row of list) {
    const entry = Number(row.entry_price);
    const open = row.next_open === null ? null : Number(row.next_open);
    const gap = open === null || !(entry > 0) ? null : (open / entry - 1) * 100;
    const marketGap = row.market_gap === null ? null : Number(row.market_gap);
    const excess = gap === null || marketGap === null ? null : gap - marketGap;
    const mark = gap === null ? "대기" : gap > 0 ? "갭상승" : "갭하락";

    if (excess !== null) { done.push(excess); scored.push(excess); }
    if (gap !== null) absolute.push(gap);

    console.log(`  ${(row.name ?? row.symbol).padEnd(12)} ${String(row.tier ?? "").padEnd(3)}` +
      ` 당일 ${pct(Number(row.entry_rate), 1).padStart(7)}` +
      `  갭 ${pct(gap).padStart(8)}  시장 ${pct(marketGap).padStart(7)}` +
      `  초과 ${(excess === null ? "  -  " : pct(excess)).padStart(8)}  ${mark}`);
  }

  if (done.length > 0) {
    const up = done.filter((value) => value > 0).length;

    console.log(`    → 초과 플러스 ${up}/${done.length} · 평균 ${pct(done.reduce((a, b) => a + b, 0) / done.length)}`);
  }

  console.log("");
}

if (scored.length > 0) {
  const up = scored.filter((value) => value > 0).length;
  const mean = scored.reduce((a, b) => a + b, 0) / scored.length;

  const gapUp = absolute.filter((value) => value > 0).length;
  const gapMean = absolute.reduce((a, b) => a + b, 0) / absolute.length;

  console.log(`합계  채점 ${scored.length}건`);
  console.log(`  실제 갭상승   ${gapUp}/${absolute.length} (${Math.round(100 * gapUp / absolute.length)}%) · 평균 ${pct(gapMean)}`);
  console.log(`  시장 대비 초과 ${up}/${scored.length} (${Math.round(100 * up / scored.length)}%) · 평균 ${pct(mean)}`);
  console.log("");
  console.log("누적 성적표(kr_close_bet_calibration)와 벌어지면 조건이 시장과 안 맞기 시작한 것입니다.");
  console.log("");
}

process.exit(0);
