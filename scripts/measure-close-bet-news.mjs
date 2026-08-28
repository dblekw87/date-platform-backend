import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 종가배팅에 재료가 있어야 하는가.
 *
 *   node scripts/measure-close-bet-news.mjs
 *
 * 사용자가 실제로 하는 방식: 네이버 증권 뉴스에서 왜 올랐는지를 보고, 이유가
 * 있어야 그날 종가에 들어간다. 지금 화면의 조건에는 그 항목이 없습니다 --
 * 회전율 5%, 60일 전고점 돌파, 윗꼬리뿐입니다.
 *
 * 뉴스는 14일치라 못 잽니다. 공시는 400일치 32만 건이고 신고 의무라 전 종목이
 * 빠짐없이 들어옵니다. 그래서 공시로 대신 잽니다 -- 정확한 대리값은 아닙니다.
 * 뉴스로만 움직인 날은 공시가 없고, 정기공시만 낸 날은 재료 없이 공시가 있습니다.
 *
 * 2026-08-28 미국에서 같은 질문을 8-K 항목별로 재보니 **실적은 예고하지 않고
 * 자금조달이 예고했습니다**(424B4 20배, 3.02 3배, 2.02는 1.20x). 국내에서도
 * 같은지 봅니다.
 *
 * 재는 값은 종가배팅 그대로입니다 -- 종가 매수, 익일 시가 매도, **그날 밤 시장
 * 평균 갭을 뺀 초과분**. 밤이 갭의 대부분을 정하므로 절대값을 재면 밤을 잽니다.
 */

const config = readConfig();
const minimumTurnoverRatio = 5;

const { rows } = await query(config, `
  WITH caps AS (
    SELECT symbol, session_date, close, volume, close * volume AS turnover,
           lag(close) OVER w AS prev_close,
           lead(open) OVER w AS next_open,
           max(close) OVER (PARTITION BY symbol ORDER BY session_date
                            ROWS BETWEEN 60 PRECEDING AND 1 PRECEDING) AS prior_high
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  shares AS (
    SELECT DISTINCT ON (symbol) symbol, market_cap / nullif(close_price, 0) AS share_count
      FROM kr_daily_universe WHERE market_cap > 0 AND close_price > 0
     ORDER BY symbol, session_date DESC
  ),
  candidates AS (
    SELECT c.symbol, c.session_date, c.close, c.prev_close, c.next_open,
           (c.close / c.prev_close - 1) * 100 AS day_move,
           (c.next_open / c.close - 1) * 100 AS gap,
           c.volume / nullif(s.share_count, 0) * 100 AS turnover_ratio
      FROM caps c
      JOIN shares s ON s.symbol = c.symbol
     WHERE c.prev_close > 0 AND c.next_open IS NOT NULL AND c.prior_high IS NOT NULL
       AND c.turnover >= 1000000000
       AND c.close > c.prior_high
       AND c.volume / nullif(s.share_count, 0) * 100 >= ${minimumTurnoverRatio}
       AND (c.close / c.prev_close - 1) * 100 >= 5
  ),
  nights AS (
    SELECT session_date, avg(gap) AS market_gap
      FROM (SELECT session_date, (lead(open) OVER (PARTITION BY symbol ORDER BY session_date) / close - 1) * 100 AS gap
              FROM kr_daily_bars WHERE close > 0) g
     WHERE gap IS NOT NULL GROUP BY session_date HAVING count(*) >= 50
  ),
  filed AS (
    SELECT DISTINCT symbol, session_date, tag
      FROM market_disclosures, unnest(tags) AS tag
     WHERE market = 'KR' AND symbol IS NOT NULL AND session_date IS NOT NULL
  )
  SELECT c.symbol, c.session_date::text AS d, c.day_move, c.turnover_ratio,
         c.gap - n.market_gap AS excess,
         coalesce(array_agg(f.tag) FILTER (WHERE f.tag IS NOT NULL), ARRAY[]::text[]) AS tags
    FROM candidates c
    JOIN nights n ON n.session_date = c.session_date
    LEFT JOIN filed f ON f.symbol = c.symbol AND f.session_date = c.session_date
   WHERE c.session_date >= (SELECT min(session_date) FROM market_disclosures WHERE market = 'KR')
   GROUP BY c.symbol, c.session_date, c.day_move, c.turnover_ratio, c.gap, n.market_gap
`);

const num = (value) => Number(value);
const stat = (list) => {
  const xs = list.map((row) => num(row.excess)).filter(Number.isFinite);

  if (xs.length === 0) return null;

  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));

  return { beat: xs.filter((x) => x > 0).length / xs.length, mean, n: xs.length, t: mean / (sd / Math.sqrt(xs.length)) };
};

const report = (label, list) => {
  const s = stat(list);

  if (!s || s.n < 30) {
    console.log(`  ${label.padEnd(22)} ${String(list.length).padStart(5)}건 — 표본 부족`);

    return;
  }

  console.log(`  ${label.padEnd(22)} ${String(s.n).padStart(5)}건 · 초과 ${(s.mean >= 0 ? "+" : "") + s.mean.toFixed(3)}%p · 상회 ${Math.round(s.beat * 100)}% · t ${s.t.toFixed(1)}`);
};

const days = new Set(rows.map((row) => row.d)).size;

console.log("");
console.log(`종가배팅 후보 ${rows.length.toLocaleString("ko-KR")}건 · ${days}개 장 · 회전율 ${minimumTurnoverRatio}%↑ · 전고점 돌파`);
console.log("종가 매수 → 익일 시가 매도, 그날 밤 시장 평균 갭을 뺀 초과분");
console.log("");

report("전체", rows);
report("공시 있음", rows.filter((row) => row.tags.length > 0));
report("공시 없음", rows.filter((row) => row.tags.length === 0));

console.log("");
console.log("공시 종류별 (미국에선 실적이 예고하지 않고 자금조달이 예고했습니다)");
console.log("");

const tags = ["실적", "계약·수주", "설비투자", "인수합병", "경영권", "증자·지분", "자금거래", "주주환원", "정기·안내", "주의", "해명"];

for (const tag of tags) report(tag, rows.filter((row) => row.tags.includes(tag)));

console.log("");
console.log("  ※ 공시는 뉴스의 대리값입니다. 뉴스로만 움직인 날은 공시가 없고,");
console.log("     정기공시만 낸 날은 재료 없이 공시가 있습니다. 방향만 읽으세요.");

process.exit(0);
