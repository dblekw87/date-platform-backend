import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 하락장 날 무엇이 올랐고 그 앞에 어떤 소식이 있었나 -- 사례 수집용.
 *
 *   node scripts/down-day-catalog.mjs [YYYY-MM-DD] [--force]
 *
 * 2026-11-06 사용자: "하락장인데 하루나 이틀쯤에 나온 소식이 있으면 그 재료가 테마가
 * 된다(보안·호남반도체·한진칼 경영권 분쟁)" → "이런 것들도 수집해 줬으면 하는데 하락장마다".
 * 7~11월 18일을 손으로 훑어 보니 정치·외교 이벤트, 사고(해킹), 지분·경영권·공개매수,
 * 신규상장, 회사 개별 재료(계약·임상), 원자재·계절로 나뉘었습니다. 같은 꼴을 매일 쌓아서
 * 12월에 "그 소식이 났는데 안 오른 날"과 비교할 표본을 만드는 게 목적입니다.
 *
 * 하락장 = ETF·ETN·스팩·거래정지를 뺀 전 종목 등락의 중앙값이 −1.2% 이하. 아니면 한 줄만
 * 찍고 끝냅니다(--force로 무시). 장 마감 뒤 kr_daily_universe(15:50~16:00)를 씁니다.
 * 종목은 그날 상승률 상위 10개와 장중에 올랐다 밀린 10개(둘 다 거래대금 50억 이상),
 * 그리고 오늘 상장입니다. 재료 후보는 고점 전 기사·공시입니다(아래 printMaterial).
 * 판정이 아니라 사람이 분류하는 재료입니다. 진입 권유로 쓰지 않습니다.
 */
const config = readConfig();
const args = process.argv.slice(2);
const force = args.includes("--force");
const day = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const nonStock = "(ETN|ETF|인버스|레버리지|선물|KODEX|TIGER|SOL |KBSTAR|ACE |RISE |PLUS |HANARO|KOSEF|ARIRANG|TIMEFOLIO|1Q |WON |BNK |마이다스|에셋플러스|히어로즈|파워 |TRUSTON|UNICORN|VITA|KIWOOM|FOCUS|TREX|스팩)";
const downLine = -1.2;

const { rows: [market] } = await query(config, `
  SELECT count(*)::int n, percentile_cont(0.5) WITHIN GROUP (ORDER BY change_rate::float8) median
    FROM kr_daily_universe
   WHERE session_date = $1 AND NOT trade_halted AND name !~ $2`, [day, nonStock]);

if (!market.n) {
  console.log(`${day} 유니버스 없음(휴장이거나 아직 안 들어옴)`);
  process.exit(0);
}

const median = Number(market.median);

if (median > downLine && !force) {
  console.log(`${day} 하락장 아님 · 전 종목 중앙 ${median.toFixed(2)}% (${market.n}종목, 기준 ${downLine}% 이하)`);
  process.exit(0);
}

/*
 * 11/22 사용자 "장중에도 올랐다가 사그라들기도 하니까 그거까지 체크해주고 어떤 재료로
 * 올랐는지도". 그래서 종가 상위만이 아니라 장중 고가로도 고릅니다. 고가는 kr_daily_bars
 * (수집기가 유니버스 직후 오늘 봉을 받음), 전일 종가는 그 표의 바로 앞 봉, 고점 시각은
 * 장중 1분 표본(kis:krx*)에서 처음 최고 등락에 닿은 때입니다 -- 순위권에 들어온 종목만
 * 표본이 있어 시각이 비면 '?'입니다.
 */
const pick = `
  WITH b AS (
    SELECT symbol, open::float8 o, high::float8 h, close::float8 c,
           (SELECT p.close::float8 FROM kr_daily_bars p WHERE p.symbol = d.symbol AND p.session_date < d.session_date
             ORDER BY p.session_date DESC LIMIT 1) pc
      FROM kr_daily_bars d WHERE session_date = $1)
  SELECT u.symbol, u.name, u.change_rate::float8 r, (u.turnover / 1e8)::float8 t,
         CASE WHEN b.pc > 0 THEN (b.h / b.pc - 1) * 100 END hi,
         CASE WHEN b.pc > 0 THEN (b.o / b.pc - 1) * 100 END op,
         (SELECT string_agg(theme_name, '/') FROM (
            SELECT DISTINCT theme_name FROM kr_theme_members m WHERE m.symbol = u.symbol ORDER BY theme_name LIMIT 3) x) themes,
         (SELECT observed_at FROM market_price_samples s
           WHERE s.symbol = u.symbol AND s.session_date = u.session_date AND s.source LIKE 'kis:krx%'
           ORDER BY s.change_rate DESC, s.observed_at LIMIT 1) peak_at
    -- LEFT: if today's bars are not in yet the close list still prints, only the high columns go '?'.
    FROM kr_daily_universe u LEFT JOIN b USING (symbol)
   WHERE u.session_date = $1 AND NOT u.trade_halted AND u.name !~ $2 AND u.turnover >= 50e8`;

const { rows: top } = await query(config, `${pick} ORDER BY u.change_rate DESC LIMIT 10`, [day, nonStock]);
const topSymbols = top.map((stock) => stock.symbol);
// 장중 +15% 이상 갔다가 고점에서 10%p 넘게 밀린 것. 종가 상위에 이미 있으면 뺍니다.
const { rows: faded } = await query(config, `
  SELECT * FROM (${pick}) z
   WHERE hi >= 15 AND hi - r >= 10 AND NOT (symbol = ANY($3))
   ORDER BY hi DESC LIMIT 10`, [day, nonStock, topSymbols]);

function signed(value) {
  return value == null ? "?" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function kst(at) {
  return at ? new Date(at.getTime() + 9 * 3600_000).toISOString().slice(11, 16) : "?";
}

/*
 * 재료 후보: 이틀 전 15:30부터 고점 시각(없으면 그날 15:30)까지의 태그 기사 3건과
 * 전날 15:30부터의 공시 2건. 장중에 나온 소식(11/17 계양전기 10:01)도 고점 전이면 잡힙니다.
 * 고점 뒤 기사는 '왜 올랐나'를 쓴 복기 기사라 뺍니다.
 */
async function printMaterial(stock) {
  const until = stock.peak_at ?? null;
  // 우선주 소식은 보통주에 붙어 옵니다(한진칼우 → 한진칼 지분 경쟁). 코드 끝이 0이 아니면 보통주도 찾습니다.
  const symbols = /0$/.test(stock.symbol) ? [stock.symbol] : [stock.symbol, `${stock.symbol.slice(0, 5)}0`];
  const { rows: news } = await query(config, `
    SELECT to_char(published_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') at, headline
      FROM (
        -- The same wire story arrives from several outlets within a minute.
        SELECT DISTINCT ON (left(headline, 30)) published_at, left(headline, 80) headline
          FROM market_news_items
         WHERE related_symbols && $1::text[]
           AND published_at >= ($2::date - 2 + time '15:30') AT TIME ZONE 'Asia/Seoul'
           AND published_at <= coalesce($3::timestamptz, ($2::date + time '15:30') AT TIME ZONE 'Asia/Seoul')
         ORDER BY left(headline, 30), published_at
      ) x
     ORDER BY published_at DESC
     LIMIT 3`, [symbols, day, until]);
  const { rows: filings } = await query(config, `
    SELECT to_char(filed_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') at, left(coalesce(report_name, title), 60) title
      FROM market_disclosures
     WHERE symbol = ANY($1::text[]) AND source = 'dart'
       AND filed_at >= ($2::date - 1 + time '15:30') AT TIME ZONE 'Asia/Seoul'
       AND filed_at <= coalesce($3::timestamptz, ($2::date + time '15:30') AT TIME ZONE 'Asia/Seoul')
     ORDER BY filed_at DESC
     LIMIT 2`, [symbols, day, until]);

  for (const item of filings) console.log(`    [공시] ${item.at} ${item.title}`);
  for (const item of news.reverse()) console.log(`    ${item.at} ${item.headline}`);
  if (!news.length && !filings.length) console.log("    (고점 전 태그 기사·공시 없음 — 제품명·영문·그룹명으로 다시 찾을 것)");
}

function printStock(stock) {
  const fade = stock.hi == null ? "" : ` · 고가 ${signed(stock.hi)}(${kst(stock.peak_at)}) → 종가 ${signed(stock.r)}, 밀림 ${(stock.hi - stock.r).toFixed(1)}%p · 시가 ${signed(stock.op)}`;

  console.log(`${stock.name} ${signed(stock.r)} ${Math.round(stock.t)}억 [${stock.themes ?? "테마 없음"}]${fade}`);
}

console.log(`${day} 하락장 사례 · 전 종목 중앙 ${median.toFixed(2)}% (${market.n}종목) · 상승률 상위 10(거래대금 50억↑)`);

for (const stock of top) {
  printStock(stock);
  await printMaterial(stock);
}

console.log(`
장중에 올랐다 사그라든 것(고가 +15%↑, 고점 대비 10%p↑ 밀림, 거래대금 50억↑) ${faded.length}개${faded.length ? "" : " (없음)"}`);

for (const stock of faded) {
  printStock(stock);
  await printMaterial(stock);
}

/*
 * 신규상장은 전일 종가가 없어 위 두 목록의 고가 계산에서 빠집니다. 시초가 기준으로 따로
 * 봅니다. 종가는 유니버스 것을 씁니다 -- 그날 저녁 봉의 close는 애프터마켓 값일 수 있습니다
 * (11/20 하나에어로 봉 5,670 vs 정규장 6,050). 하락일마다 거의 하나씩 있었고(11/06 사례집), 첫날은 개장 쏠림 뒤 61~89%가
 * 시초 아래 마감했습니다(memory ipo-down-market-verdict).
 */
const { rows: listings } = await query(config, `
  SELECT u.name, (u.turnover / 1e8)::float8 t, (b.high / b.open - 1) * 100 hi, (u.close_price / b.open - 1) * 100 cl
    FROM kr_listings l
    JOIN kr_daily_universe u ON u.symbol = l.symbol AND u.session_date = l.listed_on
    JOIN kr_daily_bars b ON b.symbol = l.symbol AND b.session_date = l.listed_on
   WHERE l.listed_on = $1 AND NOT coalesce(l.before_collection, false) AND b.open > 0
   ORDER BY u.turnover DESC`, [day]);

console.log(`
오늘 상장 ${listings.length}개${listings.length ? "" : " (없음)"}`);
for (const row of listings) {
  console.log(`  ${row.name} ${Math.round(row.t)}억 · 시초 대비 고가 ${signed(Number(row.hi))} → 종가 ${signed(Number(row.cl))}`);
}

/*
 * 우선주는 거래대금 문턱과 상관없이 따로 봅니다(11/06 사용자 "우선주도 오르는 거 기억해야 돼").
 * 그날 한진칼우·깨끗한나라우·대호특수강우·덕성우·동양2우B가 상한가였는데 대부분 거래대금이
 * 수억 원이라 위 목록에 안 걸렸습니다. 폭락일 우선주는 11일 중 10일 시장보다 나았습니다
 * (memory crash-day-theme-rotation). 보통주 등락을 옆에 둬서 보통주 재료가 번진 것인지
 * (한진칼 분쟁) 우선주만 따로 뛴 것인지(품절주) 가릅니다.
 */
const { rows: preferred } = await query(config, `
  SELECT p.name, p.change_rate::float8 r, (p.turnover / 1e8)::float8 t, c.name common, c.change_rate::float8 cr
    FROM kr_daily_universe p
    LEFT JOIN kr_daily_universe c ON c.session_date = p.session_date AND c.symbol = left(p.symbol, 5) || '0'
   WHERE p.session_date = $1 AND NOT p.trade_halted AND p.change_rate >= 10
     AND p.name ~ '[0-9]?우[A-C]?$' AND p.name !~ '(우주|그로우)$' AND p.symbol !~ '0$'
   ORDER BY p.change_rate DESC
   LIMIT 10`, [day]);

console.log(`
우선주 +10% 이상 ${preferred.length}개${preferred.length ? "" : " (없음)"}`);
for (const row of preferred) {
  console.log(`  ${row.name} +${row.r.toFixed(1)}% ${row.t.toFixed(1)}억 · 보통주 ${row.common ?? "?"} ${row.cr == null ? "?" : `${row.cr >= 0 ? "+" : ""}${row.cr.toFixed(1)}%`}`);
}

process.exit(0);
