import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 종가배팅에 재료가 있어야 하는가 -- 뉴스와 공시를 **따로**.
 *
 *   node scripts/measure-close-bet-catalyst.mjs
 *
 * 앞선 measure-close-bet-news.mjs는 공시를 뉴스의 대리값으로 썼습니다. 그것이
 * 틀렸습니다. 둘은 다른 것을 담습니다.
 *
 *   공시   신고 의무. 사후·정기가 대부분이고 시장의 해석이 없습니다.
 *   뉴스   왜 올랐는지. 소문·업황·정책·동종업체 소식까지 들어갑니다.
 *
 * 공시가 없어도 뉴스로 오를 수 있고, 그 반대도 됩니다. 그러므로 "공시가 값이
 * 없다"를 "재료가 값이 없다"로 읽으면 안 됩니다 -- 공시 축에서만 답한 것입니다.
 *
 * 표본이 갈립니다. 공시는 400일치라 11,015건, 뉴스는 17일치라 100건 안팎입니다.
 * **뉴스 쪽은 통계가 아니라 관찰입니다.** 숫자를 그렇게 읽어야 합니다.
 *
 * 재는 값은 종가배팅 그대로 -- 종가 매수, 익일 시가 매도, 그날 밤 시장 평균 갭을
 * 뺀 초과분.
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
    SELECT c.symbol, c.session_date, (c.close / c.prev_close - 1) * 100 AS day_move,
           (c.next_open / c.close - 1) * 100 AS gap
      FROM caps c
      JOIN shares s ON s.symbol = c.symbol
     WHERE c.prev_close > 0 AND c.next_open IS NOT NULL AND c.prior_high IS NOT NULL
       AND c.turnover >= 1000000000 AND c.close > c.prior_high
       AND c.volume / nullif(s.share_count, 0) * 100 >= ${minimumTurnoverRatio}
       AND (c.close / c.prev_close - 1) * 100 >= 5
  ),
  nights AS (
    SELECT session_date, avg(gap) AS market_gap
      FROM (SELECT session_date,
                   (lead(open) OVER (PARTITION BY symbol ORDER BY session_date) / close - 1) * 100 AS gap
              FROM kr_daily_bars WHERE close > 0) g
     WHERE gap IS NOT NULL GROUP BY session_date HAVING count(*) >= 50
  ),
  -- 뉴스는 당일과 전일을 봅니다. 장 마감 뒤 기사가 다음날 갭을 만드는 경우가 있어
  -- 당일만 보면 그것을 놓칩니다.
  news AS (
    SELECT DISTINCT unnest(related_symbols) AS symbol,
           date(published_at AT TIME ZONE 'Asia/Seoul') AS d
      FROM market_news_items WHERE array_length(related_symbols, 1) > 0
  ),
  filed AS (
    SELECT DISTINCT symbol, session_date, tag
      FROM market_disclosures, unnest(tags) AS tag
     WHERE market = 'KR' AND symbol IS NOT NULL AND session_date IS NOT NULL
  )
  SELECT c.symbol, c.session_date::text AS d, c.day_move,
         c.gap - n.market_gap AS excess,
         EXISTS (SELECT 1 FROM news x
                  WHERE x.symbol = c.symbol AND x.d BETWEEN c.session_date - 1 AND c.session_date) AS has_news,
         (c.session_date >= (SELECT min(d) FROM news)) AS news_covered,
         coalesce(array_agg(f.tag) FILTER (WHERE f.tag IS NOT NULL), ARRAY[]::text[]) AS tags
    FROM candidates c
    JOIN nights n ON n.session_date = c.session_date
    LEFT JOIN filed f ON f.symbol = c.symbol AND f.session_date = c.session_date
   GROUP BY c.symbol, c.session_date, c.day_move, c.gap, n.market_gap
`);

const num = (value) => Number(value);
const stat = (list) => {
  const xs = list.map((row) => num(row.excess)).filter(Number.isFinite);

  if (xs.length === 0) return null;

  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));

  return { beat: xs.filter((x) => x > 0).length / xs.length, mean, n: xs.length, t: mean / (sd / Math.sqrt(xs.length)) };
};

const report = (label, list, floor = 30) => {
  const s = stat(list);

  if (!s || s.n < floor) {
    console.log(`  ${label.padEnd(22)} ${String(list.length).padStart(5)}건 — 표본 부족`);

    return;
  }

  console.log(`  ${label.padEnd(22)} ${String(s.n).padStart(5)}건 · 초과 ${(s.mean >= 0 ? "+" : "") + s.mean.toFixed(3)}%p · 상회 ${Math.round(s.beat * 100)}% · t ${s.t.toFixed(1)}`);
};

const covered = rows.filter((row) => row.news_covered);

console.log("");
console.log(`종가배팅 후보 ${rows.length.toLocaleString("ko-KR")}건 · 회전율 ${minimumTurnoverRatio}%↑ · 전고점 돌파`);
console.log("종가 매수 → 익일 시가 매도, 그날 밤 시장 평균 갭을 뺀 초과분");
console.log("");

console.log("[A] 뉴스 축 — 뉴스 수집 기간에 한정");
console.log("");
report("전체 (기간 한정)", covered, 20);
report("  뉴스 있음", covered.filter((row) => row.has_news), 20);
report("  뉴스 없음", covered.filter((row) => !row.has_news), 20);
console.log("");
console.log(`  ※ ${covered.length}건뿐입니다. 통계가 아니라 관찰이고, 방향만 봅니다.`);

console.log("");
console.log("[B] 공시 축 — 400일 전체");
console.log("");
report("전체", rows);
report("  공시 있음", rows.filter((row) => row.tags.length > 0));
report("  공시 없음", rows.filter((row) => row.tags.length === 0));

console.log("");
console.log("[C] 둘을 겹쳐 보면 — 뉴스 기간에 한정");
console.log("");
report("뉴스O 공시O", covered.filter((row) => row.has_news && row.tags.length > 0), 15);
report("뉴스O 공시X", covered.filter((row) => row.has_news && row.tags.length === 0), 15);
report("뉴스X 공시O", covered.filter((row) => !row.has_news && row.tags.length > 0), 15);
report("뉴스X 공시X", covered.filter((row) => !row.has_news && row.tags.length === 0), 15);

console.log("");
console.log("  공시가 없어도 뉴스로 오를 수 있고 그 반대도 됩니다. 한쪽으로 다른 쪽을");
console.log("  대신할 수 없으므로 따로 셉니다.");

process.exit(0);
