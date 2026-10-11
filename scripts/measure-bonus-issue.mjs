import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 무상증자 결정 공시는 다음 장에 값이 있는가.
 *
 *   node scripts/measure-bonus-issue.mjs
 *
 * 2026-10-07 11:17 알파칩스가 `주요사항보고서(무상증자결정)`을 냈고 12:49에 상한가에
 * 닿았습니다. 그날 같은 잣대로 쟀더니 86건 상회 97%가 나왔는데, 73건이 전부 한
 * 날짜(08-24)로 뭉쳐 있었습니다 -- 과거 공시의 filed_at이 백필한 날로 찍혀 있었기
 * 때문이고, 그 하루의 시장 갭이 전부에 곱해진 것이었습니다. 2026-10-11에
 * backfill-kr-filing-times.mjs로 시각을 되받은 뒤 다시 잽니다.
 *
 * 잣대: 살 수 있는 첫 종가에 사서 다음 거래일 시가에 판 초과수익(시장 평균 갭을
 * 뺍니다). 종가배팅·상따와 같은 잣대입니다.
 *
 *   장중 공시(~15:30)   그날 종가에 삽니다
 *   장후 공시(15:30~)   그날 종가에는 못 삽니다. 다음 날 시가 갭이 반응이고, 따로
 *                       "보유했다면"으로 보여 줍니다. 사는 자리는 다음 날 종가입니다.
 *
 * 10/07 판은 경계를 15:40으로 뒀는데 종가는 정규장 15:30 종가로 고정입니다.
 *
 * [기재정정]과 `주권매매거래정지(무상증자)`는 뺍니다. 거래정지는 권리락 절차 공시라
 * 결정 공시와 다른 사건이고, 섞으면 상회가 부풀습니다(10/07에 96%).
 *
 * **날짜가 몇 개로 퍼져 있는지 꼭 같이 봅니다.** 건수가 많아도 날짜가 몇 개 없으면
 * 그 며칠의 시장이 결과를 정합니다([[measurement-pitfalls]]).
 */

const config = readConfig();

/* 시장 평균 갭. open > 0 필수 -- 0.27%의 불량행이 평균을 1.3%p 밉니다. */
const { rows: marketRows } = await query(config, `
  WITH b AS (
    SELECT session_date, open,
           lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev
      FROM kr_daily_bars
  )
  SELECT session_date::text AS d, avg((open / prev - 1) * 100)::float8 AS gap
    FROM b WHERE prev > 0 AND open > 0 GROUP BY 1`);
const marketGap = new Map(marketRows.map((row) => [row.d, Number(row.gap)]));

const { rows: sessionRows } = await query(config, "SELECT DISTINCT session_date::text AS d FROM kr_daily_bars ORDER BY 1");
const sessions = sessionRows.map((row) => row.d);
const nextOf = new Map(sessions.slice(0, -1).map((day, index) => [day, sessions[index + 1]]));
const onOrAfter = (day) => sessions.find((session) => session >= day);

const { rows: filings } = await query(config, `
  SELECT DISTINCT ON (symbol, (filed_at AT TIME ZONE 'Asia/Seoul')::date)
         symbol, company_name, filed_at_source,
         (filed_at AT TIME ZONE 'Asia/Seoul')::date::text AS day,
         to_char(filed_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at
    FROM market_disclosures
   WHERE market = 'KR' AND symbol IS NOT NULL
     AND report_name LIKE '%무상증자결정%'
     AND report_name NOT LIKE '[기재정정]%'
     AND report_name NOT LIKE '%거래정지%'
   ORDER BY symbol, (filed_at AT TIME ZONE 'Asia/Seoul')::date, filed_at`);

async function bar(symbol, day) {
  const { rows } = await query(config, `
    SELECT open::float8, close::float8,
           (SELECT close FROM kr_daily_bars p WHERE p.symbol = b.symbol AND p.session_date < b.session_date
             ORDER BY p.session_date DESC LIMIT 1)::float8 AS prev
      FROM kr_daily_bars b WHERE symbol = $1 AND session_date = $2::date`, [symbol, day]);

  return rows[0] ?? null;
}

const groups = new Map();
const add = (key, value) => {
  if (!groups.has(key)) groups.set(key, []);

  groups.get(key).push(value);
};
const sources = new Map();
let skipped = 0;

for (const row of filings) {
  sources.set(row.filed_at_source, (sources.get(row.filed_at_source) ?? 0) + 1);

  const timed = row.filed_at_source === "dart";
  const afterClose = !timed || row.at >= "15:30";
  const filedDay = onOrAfter(row.day);
  /* 장후·주말 공시는 그 다음 거래일 종가가 첫 사는 자리입니다. */
  const buyDay = afterClose || filedDay !== row.day ? nextOf.get(filedDay) ?? null : filedDay;
  const sellDay = buyDay ? nextOf.get(buyDay) : null;

  if (!buyDay || !sellDay || !marketGap.has(sellDay)) {
    skipped += 1;
    continue;
  }

  const buy = await bar(row.symbol, buyDay);
  const sell = await bar(row.symbol, sellDay);

  if (!(buy?.close > 0) || !(buy?.prev > 0) || !(sell?.open > 0)) {
    skipped += 1;
    continue;
  }

  const excess = (sell.open / buy.close - 1) * 100 - marketGap.get(sellDay);
  const dayMove = (buy.close / buy.prev - 1) * 100;
  const sample = { buyDay, excess };
  const slot = !timed ? "시각 없음(date-only)" : afterClose || filedDay !== row.day ? "장후·휴장 공시" : "장중 공시";

  add("전체", sample);
  add(slot, sample);
  add(dayMove >= 29 ? "산 날 상한가" : dayMove >= 10 ? "산 날 +10~29%" : dayMove >= 3 ? "산 날 +3~10%" : "산 날 +3% 미만", sample);

  /* 장후 공시의 반응 자체: 직전 종가 → 다음 날 시가 갭, 시장 갭 차감. 보유하고 있었다면. */
  if (timed && afterClose && filedDay === row.day) {
    const held = await bar(row.symbol, buyDay);

    if (held?.open > 0 && held?.prev > 0 && marketGap.has(buyDay)) {
      add("(보유했다면) 장후 공시 다음 날 갭", { buyDay, excess: (held.open / held.prev - 1) * 100 - marketGap.get(buyDay) });
    }
  }
}

function show(label) {
  const list = groups.get(label);

  if (!list?.length) return console.log(`  ${label.padEnd(26)} 표본 없음`);

  const values = list.map((item) => item.excess).sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const days = new Set(list.map((item) => item.buyDay)).size;
  const sign = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;

  console.log(`  ${label.padEnd(26)} ${String(list.length).padStart(4)}건 · ${String(days).padStart(3)}일 · 초과 ${sign(mean)}%p · 중앙 ${sign(values[Math.floor(values.length / 2)])} · 상회 ${Math.round(100 * values.filter((value) => value > 0).length / values.length)}%`);
}

console.log("무상증자 결정 공시 · 살 수 있는 첫 종가 → 다음 날 시가, 시장 갭 차감");
console.log("");
console.log(`  공시 ${filings.length}건 (${[...sources].map(([source, n]) => `${source} ${n}`).join(" · ")}) · 성적 못 낸 것 ${skipped}건`);
console.log("");
show("전체");
console.log("");
for (const label of ["장중 공시", "장후·휴장 공시", "시각 없음(date-only)"]) show(label);
console.log("");
for (const label of ["산 날 상한가", "산 날 +10~29%", "산 날 +3~10%", "산 날 +3% 미만"]) show(label);
console.log("");
show("(보유했다면) 장후 공시 다음 날 갭");

const days = new Map();

for (const { buyDay } of groups.get("전체") ?? []) days.set(buyDay, (days.get(buyDay) ?? 0) + 1);

const crowded = [...days].sort((a, b) => b[1] - a[1]).slice(0, 3);

console.log("");
console.log(`  가장 몰린 날: ${crowded.map(([day, n]) => `${day} ${n}건`).join(" · ")}`);
process.exit(0);
