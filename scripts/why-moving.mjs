import { query } from "../src/db/client.mjs";
import { readConfig } from "../src/config.mjs";

/**
 * 이 종목 왜 움직이나 -- 같이 움직인 종목, 움직인 시각, 그 앞뒤 기사·공시, 이벤트 지도.
 *
 *   node scripts/why-moving.mjs <종목명|코드> [YYYY-MM-DD]
 *
 * 2026-11-04 사용자 요청입니다. 그날 한화솔루션이 10:24 −2%에서 10:58 +7%로 돌았는데,
 * 이유(美 중간선거 개표에서 민주당 우세 → 태양광·2차전지 수혜, AI·반도체 규제 우려)는
 * 기사로는 11:36 이후에야 붙었습니다. 가격이 기사보다 먼저였고, 같이 오른 종목(OCI홀딩스·
 * HD현대에너지솔루션·삼성SDI)과 같이 빠진 종목(하이닉스·삼성전자)의 조합이 먼저 이유를
 * 말하고 있었습니다. 그 세 겹을 한 번에 묶어 보여 줍니다.
 *
 * 판정이 아니라 사람이 읽는 표입니다. 이유를 확정하지 않고 후보를 늘어놓습니다. 다음에
 * 뜰 테마를 맞히는 데 쓰지 않습니다(memory news-to-theme-verdict, 여섯 번 실패).
 */

const config = readConfig();
const target = process.argv[2];
const kst = new Date(Date.now() + 9 * 3600_000).toISOString();
const day = process.argv[3] ?? kst.slice(0, 10);

if (!target) {
  console.log("사용법: node scripts/why-moving.mjs <종목명|코드> [YYYY-MM-DD]");
  process.exit(1);
}

/*
 * 이벤트 → 업종 지도. 이벤트 낱말이 그날 기사에 있으면 이 줄을 붙입니다. 손으로 적은
 * 상식이지 잰 값이 아닙니다 -- 그렇게 적어 내보냅니다.
 */
const eventMap = [
  { pattern: /민주당|블루\s?웨이브|하원\s*탈환/, line: "美 민주당 우세: 태양광·풍력·2차전지(IRA)↑, AI·반도체(규제)·감세 수혜주↓" },
  { pattern: /공화당|레드\s?웨이브/, line: "美 공화당 우세: 방산·석유·가상자산↑, 신재생↓" },
  { pattern: /관세/, line: "관세: 부과·인상이면 수출주↓·내수/방산 피난, 유예·완화면 반대" },
  { pattern: /수출\s*통제|반도체\s*규제/, line: "수출통제: 강화면 반도체 장비·소재↓(국산화 수혜주는↑), 완화면 반대" },
  { pattern: /FOMC|금리\s*(인하|인상|동결)/, line: "금리: 인하 기대면 성장·바이오↑, 인상·매파면 반대·은행↑" },
  { pattern: /해킹|사이버\s*공격|개인정보\s*유출/, line: "해킹 사고: 보안주↑(급락장에서 자주 피난처)" },
  { pattern: /정상회담|APEC|G20/, line: "정상회담: 미·중 완화면 반도체·중국 소비↑, 결렬이면 반대" },
  { pattern: /전쟁|공습|미사일|휴전/, line: "전쟁: 확전이면 방산·석유↑, 휴전이면 재건·항공↑" }
];

const { rows: matches } = await query(config, `
  SELECT DISTINCT symbol, name FROM market_price_samples
   WHERE session_date = $1 AND market = 'KR' AND (symbol = $2 OR name = $2)
`, [day, target]);

if (!matches.length) {
  console.log(`${day}에 '${target}' 표본이 없습니다.`);
  process.exit(0);
}

const { symbol, name } = matches[0];
const { rows: path } = await query(config, `
  SELECT observed_at, change_rate::float8 r, turnover::float8 t
    FROM market_price_samples
   WHERE session_date = $1 AND symbol = $2 AND source LIKE 'kis:krx%'
   ORDER BY observed_at
`, [day, symbol]);

if (path.length < 3) {
  console.log(`${name}: 정규장 표본이 ${path.length}개뿐이라 움직인 시각을 못 잡습니다.`);
  process.exit(0);
}

const clock = (at) => new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: "Asia/Seoul" });

/*
 * 시장 대비로 잽니다. 처음엔 등락 그대로 쟀더니 11/04 한화솔루션의 "가장 큰 20분"이
 * 14시 시장 전체 반등(코스피 −1.4 → −0.3)으로 잡혀, 같이 움직인 종목이 하이닉스·삼성이
 * 됐습니다. 그 종목만의 움직임은 시장을 뺀 나머지입니다.
 */
const { rows: indexRows } = await query(config, `
  SELECT observed_at, change_rate::float8 r FROM macro_samples
   WHERE symbol = 'KOSPI' AND observed_at >= ($1::date + time '08:50') AT TIME ZONE 'Asia/Seoul'
     AND observed_at < ($1::date + time '15:40') AT TIME ZONE 'Asia/Seoul'
   ORDER BY observed_at
`, [day]);

function marketAt(at) {
  let value = 0;

  for (const row of indexRows) {
    if (row.observed_at > at) break;
    value = row.r;
  }

  return value;
}

// 20분 안에 시장 대비 가장 크게 오른(또는 내린) 구간의 시작을 "움직인 시각"으로 봅니다.
let best = { change: 0, from: path[0], raw: 0, to: path[0] };

for (let i = 0; i < path.length; i += 1) {
  for (let j = i + 1; j < path.length && path[j].observed_at - path[i].observed_at <= 20 * 60_000; j += 1) {
    const raw = path[j].r - path[i].r;
    const change = raw - (marketAt(path[j].observed_at) - marketAt(path[i].observed_at));

    if (Math.abs(change) > Math.abs(best.change)) best = { change, from: path[i], raw, to: path[j] };
  }
}

const last = path[path.length - 1];
const peak = path.reduce((top, row) => (row.r > top.r ? row : top), path[0]);
const start = new Date(best.from.observed_at);
const end = new Date(best.to.observed_at);

console.log(`${day} ${name}(${symbol}) — 지금 ${last.r.toFixed(1)}% · 거래대금 ${Math.round(last.t / 1e8).toLocaleString("ko-KR")}억 · 고점 ${peak.r.toFixed(1)}%(${clock(peak.observed_at)})`);
const marketMove = marketAt(end) - marketAt(start);

console.log(`시장 대비 가장 크게 움직인 20분: ${clock(start)} ${best.from.r.toFixed(1)}% → ${clock(end)} ${best.to.r.toFixed(1)}% (${best.raw >= 0 ? "+" : ""}${best.raw.toFixed(1)}%p, 코스피 ${marketMove >= 0 ? "+" : ""}${marketMove.toFixed(1)}%p → 초과 ${best.change >= 0 ? "+" : ""}${best.change.toFixed(1)}%p)`);

// 같은 창에서 같이 움직인 종목과 반대로 움직인 종목. 창 앞뒤로 10분씩 넓혀 봅니다.
const { rows: movers } = await query(config, `
  WITH w AS (
    SELECT symbol, name, observed_at, change_rate::float8 r, turnover::float8 t
      FROM market_price_samples
     WHERE session_date = $1 AND market = 'KR' AND source LIKE 'kis:krx%'
       AND observed_at BETWEEN $2::timestamptz - interval '10 minutes' AND $3::timestamptz + interval '10 minutes'
  ),
  d AS (
    SELECT symbol, max(name) name,
           (array_agg(r ORDER BY observed_at DESC))[1] - (array_agg(r ORDER BY observed_at))[1] dr,
           max(t) t
      FROM w GROUP BY symbol HAVING count(*) >= 2
  )
  SELECT symbol, name, dr, t FROM d WHERE symbol <> $4 AND t > 3e9
`, [day, start.toISOString(), end.toISOString(), symbol]);

const sign = Math.sign(best.change) || 1;

for (const row of movers) row.dr -= marketMove;

const together = movers.filter((row) => row.dr * sign >= 2).sort((a, b) => b.t - a.t).slice(0, 10);
const against = movers.filter((row) => row.dr * sign <= -1).sort((a, b) => b.t - a.t).slice(0, 6);
const fmt = (row) => `${row.name} ${row.dr >= 0 ? "+" : ""}${row.dr.toFixed(1)}%p`;

console.log(`\n같이 움직인 종목(거래대금 30억↑, 시장 대비 같은 방향 2%p↑): ${together.map(fmt).join(" · ") || "없음"}`);
console.log(`반대로 움직인 종목: ${against.map(fmt).join(" · ") || "없음"}`);

if (together.length) {
  const { rows: themes } = await query(config, `
    SELECT theme_name, count(*) n FROM kr_theme_members
     WHERE symbol = ANY($1::text[]) GROUP BY theme_name HAVING count(*) >= 2 ORDER BY n DESC LIMIT 5
  `, [[symbol, ...together.map((row) => row.symbol)]]);

  console.log(`겹치는 테마: ${themes.map((row) => `${row.theme_name}(${row.n})`).join(" · ") || "없음"}`);
}

// 움직이기 2시간 전부터 1시간 뒤까지. 기사가 가격보다 늦게 오는 일이 많아 뒤쪽도 봅니다.
const from = new Date(start.getTime() - 120 * 60_000);
const to = new Date(end.getTime() + 60 * 60_000);
const symbols = [symbol, ...together.map((row) => row.symbol)];
const { rows: own } = await query(config, `
  SELECT published_at, coalesce(original_headline, headline) h FROM market_news_items
   WHERE published_at BETWEEN $1 AND $2 AND related_symbols && $3::text[]
   ORDER BY published_at
`, [from, to, symbols]);
const { rows: macro } = await query(config, `
  SELECT published_at, coalesce(original_headline, headline) h FROM market_news_items
   WHERE published_at BETWEEN $1 AND $2 AND region = 'KR'
     AND coalesce(original_headline, headline) ~ '(선거|개표|민주당|공화당|관세|수출\\s*통제|FOMC|금리|정상회담|APEC|G20|해킹|전쟁|휴전|판결|트럼프)'
   ORDER BY published_at
`, [from, to]);
const { rows: filings } = await query(config, `
  SELECT filed_at, company_name, title FROM market_disclosures
   WHERE filed_at BETWEEN $1 AND $2 AND symbol = ANY($3::text[]) AND filed_at_source = 'dart'
   ORDER BY filed_at
`, [new Date(start.getTime() - 18 * 3600_000), to, symbols]);

const seen = new Set();
const unique = (rows, key) => rows.filter((row) => {
  const id = row[key].slice(0, 30);

  if (seen.has(id)) return false;
  seen.add(id);

  return true;
});

console.log(`\n종목·같이 움직인 종목 기사 (${clock(from)}~${clock(to)}):`);
for (const row of unique(own, "h").slice(0, 10)) console.log(`  ${clock(row.published_at)} ${row.h.slice(0, 90)}`);

console.log("\n시장 전체 이벤트 기사:");
for (const row of unique(macro, "h").slice(0, 10)) console.log(`  ${clock(row.published_at)} ${row.h.slice(0, 90)}`);

console.log("\n공시(전날 장 마감 무렵부터):");
for (const row of filings.slice(0, 8)) console.log(`  ${clock(row.filed_at)} ${row.company_name} · ${row.title.slice(0, 70)}`);

// 기사 수로 줄을 세웁니다. "민주당 압승" 기사에도 '공화당'이 한 번은 나와서, 걸리기만
// 하면 붙이던 처음 방식은 지도 다섯 줄을 다 붙였습니다(11/04).
const headlines = [...own, ...macro].map((row) => row.h);
const events = eventMap
  .map((entry) => ({ count: headlines.filter((headline) => entry.pattern.test(headline)).length, line: entry.line }))
  .filter((entry) => entry.count >= 2)
  .sort((a, b) => b.count - a.count)
  .slice(0, 2);

console.log(`\n이벤트 지도(잰 값 아님, 상식으로 적은 것 · 기사 수 순): ${events.length ? "" : "해당 없음"}`);
for (const entry of events) console.log(`  · ${entry.line} — 기사 ${entry.count}건`);

process.exit(0);
