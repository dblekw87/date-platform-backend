import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";
import { readLockQueue } from "../src/providers/limit-up-queue.mjs";

/**
 * 잠긴 시각 × 마감 잔량비 2×2를 다시 잽니다.
 *
 *   node scripts/measure-lock-queue.mjs
 *
 * limit-up-queue.mjs의 칸 숫자는 2026-10-02(10-07 보정) 13거래일 58건에서 나왔고
 * 칸당 4~38건입니다. 그때 손으로 쟀고 스크립트를 남기지 않았습니다. 이 스크립트는
 * 화면이 쓰는 readLockQueue를 그대로 불러 같은 칸을 매기므로, 측정과 화면이 다른
 * 자로 재는 일이 없습니다.
 *
 * 자는 그날 종가에 사서 다음 거래일 시가에 판 초과수익(시장 평균 갭 제거)입니다.
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
    FROM b WHERE prev > 0 AND open > 0 AND session_date >= date '2026-09-15' GROUP BY 1`);
const marketGap = new Map(marketRows.map((row) => [row.d, Number(row.gap)]));

const { rows: closes } = await query(config, `
  WITH b AS (
    SELECT symbol, session_date, open, close,
           lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev,
           lead(open) OVER (PARTITION BY symbol ORDER BY session_date) AS next_open,
           lead(session_date) OVER (PARTITION BY symbol ORDER BY session_date) AS next_day
      FROM kr_daily_bars
  )
  SELECT symbol, session_date::text AS d, next_day::text AS next_day,
         close::float8 AS close, next_open::float8 AS next_open
    FROM b
   WHERE session_date >= date '2026-09-15'
     AND prev > 0 AND (close / prev - 1) * 100 >= 29.0
     AND next_open > 0
   ORDER BY session_date, symbol`);

const cells = new Map();
let unread = 0;

for (const row of closes) {
  const read = await readLockQueue(config, row.symbol, row.d);

  if (!read?.cell || !marketGap.has(row.next_day)) {
    unread += 1;
    continue;
  }

  const excess = (row.next_open / row.close - 1) * 100 - marketGap.get(row.next_day);

  const hour = Number(read.lockedAt.slice(0, 2));
  const band = hour < 10 ? "09시대" : hour < 11 ? "10시대" : hour < 13 ? "11~12시" : "13시 이후";
  const hourKey = `${band}·${read.thin ? "얇음" : "두터움"}`;

  for (const key of [read.cell, hourKey]) {
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({ d: row.d, excess, symbol: row.symbol });
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const summarize = (rows) => {
  const values = rows.map((row) => row.excess);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const above = values.filter((value) => value > 0).length / values.length;

  return `${String(rows.length).padStart(3)}건 평균 ${mean.toFixed(2).padStart(6)}%p `
    + `중앙 ${median(values).toFixed(2).padStart(6)} 상회 ${(100 * above).toFixed(0).padStart(3)}%`;
};

const days = new Set(closes.map((row) => row.d)).size;
const split = "2026-10-02";

console.log(`종가 상한가 ${closes.length}건 · ${days}거래일 · 칸 못 매김 ${unread}건\n`);
console.log("칸                전체                                  10/02까지                     10/05 이후");

for (const key of ["오전·두터움", "오전·얇음", "오후·두터움", "오후·얇음"]) {
  const rows = cells.get(key) ?? [];
  const before = rows.filter((row) => row.d <= split);
  const after = rows.filter((row) => row.d > split);

  console.log(`${key}  ${rows.length ? summarize(rows) : "-"}  |  `
    + `${before.length ? summarize(before) : "-"}  |  ${after.length ? summarize(after) : "-"}`);
}

/*
 * 오전/오후 경계(11시)가 자의적인지 봅니다. 11:01에 잠긴 것은 오후로 갑니다
 * (2026-10-19 에스엠벡셀).
 */
console.log("\n잠긴 시각대 × 잔량");

for (const band of ["09시대", "10시대", "11~12시", "13시 이후"]) {
  for (const thin of ["두터움", "얇음"]) {
    const rows = cells.get(`${band}·${thin}`) ?? [];

    console.log(`${band.padEnd(6)} ${thin}  ${rows.length ? summarize(rows) : "-"}`);
  }
}
