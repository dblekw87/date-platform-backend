import { readConfig } from "../src/config.mjs";
import { query } from "../src/db/client.mjs";

/**
 * 종가배팅을 실제 매매 시각으로 재고, 뉴스 조건을 얹습니다.
 *
 *   node scripts/measure-close-bet-exit.mjs
 *
 * 지금까지는 익일 **시가**로 팔았다고 가정했습니다. 실제로는 다릅니다.
 *
 *   정규장   15:30 마감 전 매수 → 다음날 09:05~09:10 매도
 *   NXT     20:00 마감 전 매수 → 다음날 프리마켓 08:00~08:05 매도
 *
 * 시가는 동시호가로 정해지는 한 점이고, 09:05는 5분간 실제로 거래된 뒤의 값입니다.
 * 갭이 열리자마자 빠지는 종목이 많으므로 둘은 다른 숫자입니다.
 *
 * 그리고 뉴스 조건을 얹습니다. 앞선 측정에서 "뉴스가 있다"가 아니라 **"뉴스가
 * 먼저 나왔다"**가 갈림길이었습니다 -- 기사 시점에 20% 넘게 올라 있었으면 그
 * 뒤 추가분이 정확히 0이었습니다.
 *
 * 분봉이 짧아 표본이 작습니다. 관찰로 읽으세요.
 */

const config = readConfig();

const { rows } = await query(config, `
  WITH caps AS (
    SELECT symbol, session_date, close, volume, close * volume AS turnover,
           lag(close) OVER w AS prev_close,
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
    SELECT c.symbol, c.session_date, c.close,
           (c.close / c.prev_close - 1) * 100 AS day_move
      FROM caps c
      JOIN shares s ON s.symbol = c.symbol
     WHERE c.prev_close > 0 AND c.prior_high IS NOT NULL
       AND c.turnover >= 1000000000 AND c.close > c.prior_high
       AND c.volume / nullif(s.share_count, 0) * 100 >= 5
       AND (c.close / c.prev_close - 1) * 100 >= 5
  ),
  -- 다음 거래일.
  nextday AS (
    SELECT c.symbol, c.session_date, c.close AS entry,
           (SELECT min(session_date) FROM kr_daily_bars d
             WHERE d.symbol = c.symbol AND d.session_date > c.session_date) AS next_date
      FROM candidates c
  ),
  -- 실제 청산 시각의 값. 분봉에서 09:05~09:10 사이 마지막 표본을 씁니다.
  exits AS (
    SELECT n.symbol, n.session_date, n.entry, n.next_date,
           (SELECT s.change_rate FROM market_price_samples s
             WHERE s.symbol = n.symbol AND s.session_date = n.next_date
               AND s.market = 'KR' AND s.source LIKE 'kis:krx%'
               AND s.observed_at AT TIME ZONE 'Asia/Seoul' < (n.next_date + interval '9 hours 11 minutes')
               AND s.observed_at AT TIME ZONE 'Asia/Seoul' >= (n.next_date + interval '9 hours 5 minutes')
             ORDER BY s.observed_at DESC LIMIT 1) AS exit_rate,
           (SELECT open FROM kr_daily_bars d
             WHERE d.symbol = n.symbol AND d.session_date = n.next_date) AS next_open,
           (SELECT close FROM kr_daily_bars d
             WHERE d.symbol = n.symbol AND d.session_date = n.next_date) AS next_close
      FROM nextday n WHERE n.next_date IS NOT NULL
  ),
  -- 그날 그 종목의 기사 중 가장 이른 것과, 그 시점의 등락률.
  first_news AS (
    SELECT DISTINCT ON (symbol, d) symbol, d, published_at
      FROM (SELECT unnest(related_symbols) AS symbol,
                   date(published_at AT TIME ZONE 'Asia/Seoul') AS d, published_at
              FROM market_news_items
             WHERE array_length(related_symbols, 1) > 0 AND headline ~ '[가-힣]') t
     ORDER BY symbol, d, published_at
  ),
  market AS (
    SELECT session_date, avg(gap) AS market_gap
      FROM (SELECT session_date,
                   (lead(open) OVER (PARTITION BY symbol ORDER BY session_date) / close - 1) * 100 AS gap
              FROM kr_daily_bars WHERE close > 0) g
     WHERE gap IS NOT NULL GROUP BY session_date HAVING count(*) >= 50
  )
  SELECT e.symbol, e.session_date::text AS d, c.day_move,
         e.exit_rate,
         (e.next_open / e.entry - 1) * 100 - m.market_gap AS open_excess,
         (SELECT name FROM kr_daily_universe u WHERE u.symbol = e.symbol
           ORDER BY session_date DESC LIMIT 1) AS name,
         f.published_at IS NOT NULL AS has_news,
         (SELECT s.change_rate FROM market_price_samples s
           WHERE s.symbol = e.symbol AND s.session_date = e.session_date
             AND s.market = 'KR' AND s.source LIKE 'kis:krx%'
             AND s.observed_at <= f.published_at
           ORDER BY s.observed_at DESC LIMIT 1) AS news_at_rate,
         (e.session_date >= (SELECT min(d) FROM first_news)) AS news_covered
    FROM exits e
    JOIN candidates c ON c.symbol = e.symbol AND c.session_date = e.session_date
    JOIN market m ON m.session_date = e.session_date
    LEFT JOIN first_news f ON f.symbol = e.symbol AND f.d = e.session_date
   WHERE e.next_open IS NOT NULL
`);

const num = (value) => (value === null || value === undefined ? null : Number(value));
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const report = (label, list, key, floor = 15) => {
  const xs = list.map((row) => num(row[key])).filter((value) => value !== null && Number.isFinite(value));

  if (xs.length < floor) {
    console.log(`  ${label.padEnd(26)} ${String(xs.length).padStart(4)}건 — 표본 부족`);

    return;
  }

  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;

  console.log(`  ${label.padEnd(26)} ${String(xs.length).padStart(4)}건 · 평균 ${(mean >= 0 ? "+" : "") + mean.toFixed(2)}%p · 중앙 ${(med(xs) >= 0 ? "+" : "") + med(xs).toFixed(2)}%p · 상회 ${Math.round(xs.filter((x) => x > 0).length / xs.length * 100)}%`);
};

const withExit = rows.filter((row) => row.exit_rate !== null);
const covered = rows.filter((row) => row.news_covered);

console.log("");
console.log(`종가배팅 후보 ${rows.length.toLocaleString("ko-KR")}건 · 분봉으로 09:05~09:10 청산이 잡힌 것 ${withExit.length}건`);
console.log("");

console.log("[1] 청산 시각을 바꾸면 — 익일 시가 vs 09:05~09:10");
console.log("");
report("익일 시가 (시장 대비)", withExit, "open_excess");
report("09:05~09:10 (절대)", withExit, "exit_rate");
console.log("");
console.log("  ※ 시가는 시장 평균을 뺀 초과분, 09:05는 그 시점 절대 등락률입니다.");
console.log("     기준이 달라 직접 비교하지 마세요 -- 각각의 크기만 봅니다.");

console.log("");
console.log("[2] 뉴스 조건 — 뉴스 수집 기간에 한정");
console.log("");
report("전체", covered, "open_excess");
report("  뉴스 있음", covered.filter((row) => row.has_news), "open_excess");
report("  뉴스 없음", covered.filter((row) => !row.has_news), "open_excess");

console.log("");
console.log("[3] 뉴스가 **먼저** 나왔는가 — 기사 시점의 등락률로");
console.log("");
const timed = covered.filter((row) => row.has_news && num(row.news_at_rate) !== null);

report("기사 시점 10% 미만", timed.filter((row) => num(row.news_at_rate) < 10), "open_excess", 8);
report("기사 시점 10~20%", timed.filter((row) => num(row.news_at_rate) >= 10 && num(row.news_at_rate) < 20), "open_excess", 8);
report("기사 시점 20% 이상", timed.filter((row) => num(row.news_at_rate) >= 20), "open_excess", 8);

console.log("");
console.log(`  기사 시각이 분봉과 맞물린 것 ${timed.length}건. 표본이 매우 작으므로`);
console.log("  방향만 읽고, 조건으로 넣기 전에 2주 더 기다리세요.");

process.exit(0);
