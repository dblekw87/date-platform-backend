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
 * 종목은 그날 상승률 상위 10개(거래대금 50억 이상), 기사는 개장 전 48시간
 * (이틀 전 15:30 ~ 그날 10:00)에서 그 종목 태그가 붙은 것 최대 3건입니다.
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

const { rows: top } = await query(config, `
  SELECT u.symbol, u.name, u.change_rate::float8 r, (u.turnover / 1e8)::float8 t,
         (SELECT string_agg(theme_name, '/') FROM (
            SELECT DISTINCT theme_name FROM kr_theme_members m WHERE m.symbol = u.symbol ORDER BY theme_name LIMIT 3) x) themes
    FROM kr_daily_universe u
   WHERE u.session_date = $1 AND NOT u.trade_halted AND u.name !~ $2 AND u.turnover >= 50e8
   ORDER BY u.change_rate DESC
   LIMIT 10`, [day, nonStock]);

console.log(`${day} 하락장 사례 · 전 종목 중앙 ${median.toFixed(2)}% (${market.n}종목) · 상승률 상위 10(거래대금 50억↑)`);

for (const stock of top) {
  const { rows: news } = await query(config, `
    SELECT to_char(published_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') at, headline
      FROM (
        -- The same wire story arrives from several outlets within a minute.
        SELECT DISTINCT ON (left(headline, 30)) published_at, left(headline, 80) headline
          FROM market_news_items
         WHERE $1 = ANY(related_symbols)
           AND published_at >= ($2::date - 2 + time '15:30') AT TIME ZONE 'Asia/Seoul'
           AND published_at < ($2::date + time '10:00') AT TIME ZONE 'Asia/Seoul'
         ORDER BY left(headline, 30), published_at
      ) x
     ORDER BY published_at
     LIMIT 3`, [stock.symbol, day]);

  console.log(`${stock.name} +${stock.r.toFixed(1)}% ${Math.round(stock.t)}억 [${stock.themes ?? "테마 없음"}]`);
  for (const item of news) console.log(`    ${item.at} ${item.headline}`);
  if (!news.length) console.log("    (개장 전 48시간 태그 기사 없음 — 제품명·영문·그룹명으로 다시 찾을 것)");
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

console.log(`우선주 +10% 이상 ${preferred.length}개${preferred.length ? "" : " (없음)"}`);
for (const row of preferred) {
  console.log(`  ${row.name} +${row.r.toFixed(1)}% ${row.t.toFixed(1)}억 · 보통주 ${row.common ?? "?"} ${row.cr == null ? "?" : `${row.cr >= 0 ? "+" : ""}${row.cr.toFixed(1)}%`}`);
}

process.exit(0);
