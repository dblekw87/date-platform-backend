import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";
import { classifyDisclosure, isMachineHeadline, isReasonHeadline, mentionsBadNews } from "../src/providers/overnight-classify.mjs";

/**
 * 상한가 근거 창을 08:00에서 **전 거래일 15:40**으로 당기면 무엇이 달라지는가.
 *
 *   node scripts/measure-limit-up-overnight-evidence.mjs [since]
 *
 * 2026-10-14 프롬바이오가 상한가에 갔는데 "근거 없음"으로 알림이 보류됐습니다. 이유는
 * 06:01 조선비즈 단독 "프롬바이오, 경영권 매각 추진"이었고 isReasonHeadline도 통과합니다.
 * limit-up-evidence.mjs의 창이 08:00부터라 새벽 기사가 창 밖이었습니다. 전날 장 마감 뒤
 * 공시(국제약품 10/06 18:01 최대주주변경 → 10/07 상한가)도 같은 이유로 빠집니다.
 *
 * 잣대: 종가가 29.5% 이상인 종목-일마다 filing·direct 근거를 두 창으로 다시 판정하고,
 * 새 창에서만 근거가 생긴 칸의 다음 날 시가 초과(시장 평균 갭 대비)를 같이 봅니다.
 * 시장 평균에는 `open > 0`을 겁니다([[measurement-pitfalls]]). 분할 행(−31% 미만)은 뺍니다.
 */

const config = readConfig();
const since = process.argv[2] ?? "2025-10-01";

const { rows: locks } = await query(config, `
  SELECT u.session_date::text AS day, u.symbol, u.name, u.market_cap::float8 AS cap,
         (SELECT max(p.session_date)::text FROM kr_daily_universe p WHERE p.session_date < u.session_date) AS prev_day,
         (SELECT min(n.session_date)::text FROM kr_daily_universe n WHERE n.session_date > u.session_date) AS next_day
    FROM kr_daily_universe u
   WHERE u.session_date >= $1::date AND u.change_rate >= 29.5 AND u.close_price > 0
   ORDER BY u.session_date, u.symbol`, [since]);

const { rows: gaps } = await query(config, `
  WITH g AS (
    SELECT b.session_date, b.symbol, b.open / nullif(p.close, 0) - 1 AS gap
      FROM kr_daily_bars b
      JOIN LATERAL (SELECT close FROM kr_daily_bars q WHERE q.symbol = b.symbol AND q.session_date < b.session_date
                     ORDER BY q.session_date DESC LIMIT 1) p ON true
     WHERE b.session_date >= $1::date AND b.open > 0 AND p.close > 0
  )
  SELECT session_date::text AS day, symbol, gap::float8,
         avg(gap) FILTER (WHERE gap > -0.31) OVER (PARTITION BY session_date)::float8 AS market
    FROM g`, [since]);
const gapOf = new Map(gaps.map((row) => [`${row.day}|${row.symbol}`, row]));

async function evidence(symbol, from, to) {
  const filed = await query(config, `
    SELECT report_name, title FROM market_disclosures
     WHERE market = 'KR' AND symbol = $1 AND filed_at >= $2 AND filed_at < $3`, [symbol, from, to]);
  const filings = filed.rows.filter((row) => !String(row.report_name ?? "").startsWith("[기재정정]")
    && classifyDisclosure(row.report_name, row.title) === "good");
  const news = await query(config, `
    SELECT headline FROM market_news_items, LATERAL unnest(related_symbols) s
     WHERE region = 'KR' AND s = $1 AND published_at >= $2 AND published_at < $3`, [symbol, from, to]);
  const reasons = news.rows.filter((row) => isReasonHeadline(row.headline) && !mentionsBadNews(row.headline) && !isMachineHeadline(row.headline));

  return { filing: filings.length > 0, news: reasons.length > 0, sample: filings[0]?.report_name ?? reasons[0]?.headline ?? null };
}

const cells = new Map();
const added = [];

function bump(key, excess) {
  const cell = cells.get(key) ?? { count: 0, days: new Set(), excess: [] };

  cell.count += 1;
  if (excess !== null) cell.excess.push(excess);
  cells.set(key, cell);

  return cell;
}

for (const lock of locks) {
  if (!lock.prev_day) continue;

  const oldFrom = new Date(`${lock.day}T08:00:00+09:00`);
  const newFrom = new Date(`${lock.prev_day}T15:40:00+09:00`);
  const to = new Date(`${lock.day}T20:00:00+09:00`);
  const before = await evidence(lock.symbol, oldFrom, to);
  const after = await evidence(lock.symbol, newFrom, to);
  const hadOld = before.filing || before.news;
  const hasNew = after.filing || after.news;
  const gap = lock.next_day ? gapOf.get(`${lock.next_day}|${lock.symbol}`) : null;
  const excess = gap && gap.gap > -0.31 ? (gap.gap - gap.market) * 100 : null;
  const key = hadOld ? "기존 창에서도 근거" : hasNew ? "새 창에서만 근거" : "둘 다 근거 없음";

  bump(key, excess).days.add(lock.day);

  if (!hadOld && hasNew) {
    const early = await evidence(lock.symbol, newFrom, oldFrom);

    added.push({ day: lock.day, name: lock.name, excess, sample: early.sample, filing: early.filing });
  }
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const fmt = (value) => value === null ? "-" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;

console.log(`상한가 종목-일 ${locks.length}건 · ${since}~`);
console.log("칸                     건수  날짜  익일시가 초과 중앙  평균   상회");

for (const [key, cell] of cells) {
  const mean = cell.excess.length ? cell.excess.reduce((a, b) => a + b, 0) / cell.excess.length : null;
  const beat = cell.excess.length ? Math.round(100 * cell.excess.filter((v) => v > 0).length / cell.excess.length) : null;

  console.log(`${key.padEnd(20)} ${String(cell.count).padStart(5)} ${String(cell.days.size).padStart(5)}   ${fmt(median(cell.excess)).padStart(7)}  ${fmt(mean).padStart(7)}  ${beat ?? "-"}%`);
}

console.log("\n새 창에서만 근거가 생긴 것 (최근 20):");
for (const row of added.slice(-20)) {
  console.log(`  ${row.day} ${row.name} · ${fmt(row.excess)} · ${row.filing ? "공시" : "기사"} ${String(row.sample ?? "").slice(0, 60)}`);
}
