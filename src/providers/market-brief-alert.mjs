import { classifyTheme } from "./themes.mjs";
import { isKrMarketOpen } from "./kis.mjs";
import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";
import { sessionDate } from "./market-session.mjs";
import { themeForSicCode } from "./us-industry.mjs";

/**
 * 아침 시황 한 통 -- 밤사이 미국, 어제 국내장, 프리마켓, 밤사이 재료.
 *
 * 사용자가 2026-09-30에 "방금 얘기해준 걸 매일 아침 8시에" 요청해서 만들었습니다.
 * 그날 손으로 정리해 드린 것과 같은 구성입니다.
 *
 * **08:00입니다.** 07:00 복기, 07:10 주말 브리핑, 07:30 신규상장이 이미 있어서
 * 그 뒤가 비어 있고, 사용자는 08:00에 출근해 08:30쯤 처음 봅니다. 프리마켓이
 * 08:00에 막 열리므로 그 칸은 얇게 나옵니다 -- 없는 것을 있는 척하지 않고
 * "개장 직후"라고 적습니다.
 *
 * 무엇을 넣지 않았나:
 *
 *   판단·추천   이 통은 시황이고, 무엇을 사라는 말은 여기 없습니다. 재료가 붙은
 *               후보는 [다음 장 후보]가 따로 보냅니다.
 *   지수 등락만  어제 지수만 적으면 "올랐다/내렸다"로 끝나는데, 2026-09-29처럼
 *               상한가가 여섯인데 하락이 2,727종목인 날이 있습니다. 그날 화면은
 *               강해 보이고 시장은 약했습니다. 그래서 **상승/하락 종목 수**를
 *               같이 적습니다 -- 돈이 몰린 장인지 고르게 오른 장인지가 갈립니다.
 */

/*
 * 08:20입니다. 08:00이었는데, 그 순간은 NXT 프리마켓이 막 열린 참이라 프리마켓
 * 칸이 늘 비었습니다 -- 사용자는 08:00 도착해서 08:30에 처음 봅니다. 읽는 시각이
 * 같다면 20분 더 기다려 실제 체결이 담긴 쪽이 낫습니다.
 */
const alertMinute = 8 * 60 + 20;
const stopMinute = 8 * 60 + 40;
/* 어제 상위를 셀 때의 거래대금 바닥. 이보다 얇으면 호가 몇 개로 만들어진 등락이라
   "어제 무엇이 갔나"를 왜곡합니다. */
const minTurnover = 3e10;

let running = false;

const pct = (value) => `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
const eok = (won) => `${Math.round(Number(won) / 1e8).toLocaleString("ko-KR")}억`;

/*
 * 국내장에 옮겨붙는 미국 종목을 묶어서 봅니다.
 *
 * 지수 숫자만으로는 오늘 국내에서 무엇이 갈지 안 보입니다. 사용자가 보는 다른
 * 브리핑이 이 모양이고(2026-09-30), 우리가 잰 것과도 맞습니다:
 *
 *   반도체   SOX가 나스닥보다 국내 반도체를 더 끕니다(0.42 대 0.36). 둘이 갈리면
 *            힘이 죽습니다 [[us-to-kr-semis]].
 *   AI 인프라 방아쇠는 미국 **전력주**지 NVDA가 아닙니다 [[us-ai-infra-to-kr]].
 *   광통신    같은 측정에서 **국내로 안 옮겨붙었습니다.** 그래도 적는 것은 시황이고,
 *            안 옮겨붙는다는 사실도 읽을 값이기 때문입니다.
 *
 * 티커는 고정입니다. 매일 상위 몇 개를 뽑으면 그날그날 다른 종목이 올라와 어제와
 * 비교가 안 됩니다. 같은 자리에 같은 이름이 있어야 "어제보다 식었나"가 보입니다.
 */
const usGroups = [
  { label: "메모리", tickers: [["MU", "마이크론"], ["SNDK", "샌디스크"], ["WDC", "웨스턴디지털"]] },
  { label: "반도체 장비", tickers: [["AMAT", "어플라이드"], ["KLAC", "KLA"], ["LRCX", "램리서치"], ["ASML", "ASML"]] },
  { label: "AI 인프라·전력", tickers: [["VST", "비스트라"], ["CEG", "콘스텔레이션"], ["GEV", "GE버노바"], ["BE", "블룸에너지"]] },
  { label: "광통신", tickers: [["GLW", "코닝"], ["COHR", "코히런트"], ["LITE", "루멘텀"]] },
  { label: "대형", tickers: [["NVDA", "엔비디아"], ["AVGO", "브로드컴"], ["TSM", "TSMC"], ["TSLA", "테슬라"]] }
];

async function usGroupLines(config) {
  const wanted = usGroups.flatMap((group) => group.tickers.map(([ticker]) => ticker));
  const { rows } = await query(config, `
    SELECT DISTINCT ON (symbol) symbol, change_rate::float8 AS rate
      FROM market_price_samples
     WHERE market = 'US' AND symbol = ANY($1) AND change_rate IS NOT NULL
       AND observed_at > now() - interval '20 hours'
     ORDER BY symbol, observed_at DESC`, [wanted]);
  const byTicker = new Map(rows.map((row) => [row.symbol, Number(row.rate)]));
  const lines = [];

  for (const group of usGroups) {
    const parts = group.tickers
      .filter(([ticker]) => byTicker.has(ticker))
      .map(([ticker, name]) => `${name} ${pct(byTicker.get(ticker))}`);

    if (parts.length) lines.push(`  ${group.label} · ${parts.join(" · ")}`);
  }

  return lines;
}

/*
 * 밤사이 미국에서 어느 섹터가 올랐나.
 *
 * 위 묶음은 티커가 고정이라 거기 없는 섹터는 안 보입니다. 2026-10-09(금) 미국장은
 * 바이오(116종목 중 80% 상승)와 광통신(루멘텀 +5.5, 시에나 +5.9)이 갔는데, 아침
 * 시황에는 바이오 칸이 없었습니다 -- 사용자가 차트를 보고 먼저 알았습니다(10-11).
 * 그래서 밤새 찍은 전 종목 표본을 섹터로 묶어 순위를 매깁니다.
 *
 * 섹터는 보드와 같은 것을 씁니다: 손으로 고른 테마(themes.mjs)가 먼저고, 거기 없는
 * 종목은 SEC 업종(us-industry.mjs)으로 떨어집니다. 업종은 **저장된 것만** 읽습니다 --
 * 아침 알림이 SEC에 수백 번 묻고 있을 수는 없습니다.
 *
 * 미국 일봉(us_daily_bars)은 쓸 수 없습니다. 파이프라인이 UTC 날짜가 넘어간 뒤
 * (한국 09:00)에야 전날 세션을 받아서, 08:20에는 늘 하루 전 것입니다. 장중 표본의
 * 마지막 값이 정규장 종가 등락이고, 거래대금은 표본에 없어 전날 종가 × 거래량으로
 * 어림합니다 -- 거르는 데만 쓰니 그 정도면 됩니다.
 *
 * 보통주만 셉니다. ETF가 섞이면 XBI(바이오 ETF)가 바이오 종목 하나로 들어갑니다.
 * 섹터 값은 **중앙값**입니다 -- 한 종목이 +30% 가면 평균이 섹터를 대신 말합니다.
 */
const sectorMinTurnover = 2e7;
const sectorMinMembers = 5;
/* SEC 업종의 통신장비(SIC 366)에 루멘텀·시에나가 들어갑니다. 국내에서 읽는 이름으로. */
const sectorAliases = { "통신장비": "광통신·네트워크" };

/*
 * 직전 미국 정규장의 보통주 한 줄씩 -- 섹터를 붙이고 거래대금 바닥 아래는 버립니다.
 * 섹터 순위와 상승 종목 목록이 같은 표본·같은 섹터 이름을 쓰게 하려고 나눴습니다.
 * 그래야 아침 브리핑의 "바이오 +3.1%"와 그 아래 종목 이름이 같은 자로 잰 것이 됩니다.
 */
async function usSessionStocks(config) {
  const { rows } = await query(config, `
    WITH latest AS (
      SELECT max(session_date) AS day FROM market_price_samples
       WHERE market = 'US' AND source = 'yahoo:us:regular:seen'
    )
    SELECT DISTINCT ON (s.symbol) s.symbol, s.name, s.session_date::text AS day,
           s.change_rate::float8 AS rate, (s.volume * p.close)::float8 AS turnover, i.sic
      FROM market_price_samples s
      JOIN latest l ON s.session_date = l.day
      JOIN LATERAL (
        SELECT cik FROM us_tickers t
         WHERE t.symbol = s.symbol AND t.active AND t.type = 'CS'
         ORDER BY as_of DESC LIMIT 1
      ) k ON true
      JOIN LATERAL (
        SELECT close FROM us_daily_bars d
         WHERE d.symbol = s.symbol AND d.session_date < s.session_date
         ORDER BY d.session_date DESC LIMIT 1
      ) p ON true
      LEFT JOIN us_company_industry i ON i.cik = k.cik
     WHERE s.market = 'US' AND s.source = 'yahoo:us:regular:seen' AND s.change_rate IS NOT NULL
     ORDER BY s.symbol, s.observed_at DESC`);
  const stocks = [];

  for (const row of rows) {
    if (!(row.turnover >= sectorMinTurnover)) continue;

    let sector = classifyTheme(row.symbol, row.name);

    if (sector === "미분류") sector = themeForSicCode(row.sic) ?? sector;
    if (sector === "ETF") continue;

    stocks.push({ ...row, sector: sectorAliases[sector] ?? sector });
  }

  return stocks;
}

export async function usSectorLines(config) {
  const sectors = new Map();

  for (const row of await usSessionStocks(config)) {
    if (row.sector === "미분류") continue;
    if (!sectors.has(row.sector)) sectors.set(row.sector, []);

    sectors.get(row.sector).push(row);
  }

  const ranked = [...sectors]
    .filter(([, members]) => members.length >= sectorMinMembers)
    .map(([sector, members]) => {
      const rates = members.map((row) => row.rate).sort((a, b) => a - b);
      const leaders = [...members].sort((a, b) => b.turnover - a.turnover).slice(0, 3);

      return {
        leaders: leaders.map((row) => `${row.symbol} ${pct(row.rate)}`).join(" · "),
        median: rates[Math.floor(rates.length / 2)],
        n: members.length,
        sector,
        up: Math.round(100 * rates.filter((rate) => rate > 0).length / rates.length)
      };
    })
    .sort((a, b) => b.median - a.median);

  if (ranked.length < 4) return [];

  const line = (item) => `  ${item.sector} ${pct(item.median)} (${item.n}종목 중 ${item.up}% 상승) · ${item.leaders}`;

  return [
    "  오른 섹터 (중앙값)",
    ...ranked.slice(0, 4).map(line),
    "  내린 섹터",
    ...ranked.slice(-2).reverse().map(line)
  ];
}

/*
 * 직전 미국 정규장에서 많이 오른 종목.
 *
 * 사용자 요청(2026-10-18): 07:30 아침 브리핑에 "전날 미국장에서 올랐던 것들, 종목들".
 * 그 루틴은 클라우드에서 돌아 이 DB에 닿지 못하고 보드 스냅샷만 읽으므로, 보드에
 * 실어 보냅니다. 보드의 usLeadingStocks는 토스 순위라 쓸 수 없었습니다 -- 쿼터가
 * 막힌 뒤로 거래대금이 $2,525B처럼 찍힙니다.
 *
 * 섹터 순위와 같은 표본(보통주 · 거래대금 약 $20M 이상)입니다. 문턱 아래의 +100%는
 * 호가 몇 개로 만들어진 것이라 "어제 무엇이 갔나"를 대신 말하게 둘 수 없습니다.
 * 그래도 위쪽은 나노캡 급등이 많습니다 -- 탐지된 것이지 매수 신호가 아닙니다
 * ([[us-nanocap-blindspot]]). 그래서 거래대금과 섹터를 같이 실어 읽는 쪽이 거르게 둡니다.
 *
 * 묶음은 둘입니다. 상승률만 세면 10-16에 열 자리가 HODO·SGRX 같은 소형주로 차고
 * 그날 오른 XOM·LMT는 안 나옵니다. 국내로 옮겨붙는 쪽은 대개 후자라, 거래대금
 * $500M 이상에서 따로 다섯을 뽑습니다. 겹치는 종목은 큰 쪽에만 둡니다.
 */
const gainerCount = 10;
const largeGainerCount = 5;
const largeMinTurnover = 5e8;

export async function loadUsOvernightGainers(config) {
  const rising = (await usSessionStocks(config))
    .filter((row) => row.rate > 0)
    .sort((a, b) => b.rate - a.rate);
  const large = rising.filter((row) => row.turnover >= largeMinTurnover).slice(0, largeGainerCount);
  const taken = new Set(large.map((row) => row.symbol));
  const rest = rising.filter((row) => !taken.has(row.symbol)).slice(0, gainerCount);
  const shape = (group) => (row) => ({
    changeRateValue: Number(row.rate.toFixed(2)),
    group,
    name: row.name,
    sector: row.sector,
    sessionDate: row.day,
    symbol: row.symbol,
    turnoverValue: Math.round(row.turnover)
  });

  return [...large.map(shape("거래대금 $500M 이상")), ...rest.map(shape("상승률 상위"))];
}

/* 밤사이 미국. 우리가 이미 1분마다 찍는 값이라 새로 받아올 것이 없습니다. */
async function macroLines(config) {
  const { rows } = await query(config, `
    SELECT DISTINCT ON (snapshot_id) snapshot_id, label, value::float8, change_rate::float8
      FROM macro_samples
     WHERE observed_at > now() - interval '12 hours'
     ORDER BY snapshot_id, observed_at DESC`);
  const byId = new Map(rows.map((row) => [row.snapshot_id, row]));
  const pick = (id) => {
    const row = byId.get(id);

    return row ? `${row.label} ${row.value.toLocaleString("ko-KR")} ${pct(row.change_rate)}` : null;
  };

  return [
    pick("nasdaq-future"),
    pick("sp500-future"),
    pick("phlx-sox"),
    pick("us10y"),
    pick("usd-krw"),
    pick("wti")
  ].filter(Boolean);
}

/*
 * 어제 국내장. 지수가 아니라 종목 분포로 씁니다.
 *
 * kr_daily_bars에는 지수가 없고, 있더라도 지수만으로는 그날의 성격을 못 봅니다.
 * 오른 종목과 내린 종목의 수가 그날 돈이 퍼졌는지 몰렸는지를 바로 말해 줍니다.
 */
async function yesterdayLines(config, day) {
  const { rows } = await query(config, `
    WITH b AS (
      SELECT symbol, session_date, close,
             lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev,
             volume
        FROM kr_daily_bars WHERE session_date >= $1::date - 10
    ),
    last AS (SELECT max(session_date) AS d FROM kr_daily_bars WHERE session_date < $1::date)
    SELECT (SELECT d FROM last)::text AS day,
           count(*) FILTER (WHERE close > prev) AS up,
           count(*) FILTER (WHERE close < prev) AS down,
           round(avg((close / prev - 1) * 100)::numeric, 2)::float8 AS avg_move,
           count(*) FILTER (WHERE close / prev >= 1.295) AS locked
      FROM b WHERE session_date = (SELECT d FROM last) AND prev > 0`, [day]);
  const row = rows[0];

  if (!row?.day) return { lines: [], day: null };

  return {
    day: row.day,
    lines: [`상승 ${row.up} · 하락 ${row.down} · 평균 ${pct(row.avg_move)} · 상한가 ${row.locked}종목`]
  };
}

async function yesterdayLeaders(config, previous) {
  const { rows } = await query(config, `
    WITH b AS (
      SELECT symbol, session_date, close, volume,
             lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev
        FROM kr_daily_bars WHERE session_date >= $1::date - 10
    ),
    u AS (
      SELECT DISTINCT ON (symbol) symbol, name FROM kr_daily_universe
       WHERE session_date = $1::date ORDER BY symbol, session_date DESC
    )
    SELECT u.name, ((b.close / b.prev - 1) * 100)::float8 AS move, (b.close * b.volume)::float8 AS turnover
      FROM b JOIN u ON u.symbol = b.symbol
     WHERE b.session_date = $1::date AND b.prev > 0 AND b.close * b.volume >= $2
     ORDER BY move DESC LIMIT 6`, [previous, minTurnover]);

  return rows.map((row) => `  ${pct(row.move)} ${row.name} ${eok(row.turnover)}`);
}

/* 지금 프리마켓. 08:00이면 막 열린 참이라 비어 있을 수 있습니다. */
async function premarketLines(config, day) {
  const { rows } = await query(config, `
    SELECT DISTINCT ON (symbol) name, change_rate::float8 AS rate, turnover::float8 AS turnover, theme
      FROM market_price_samples
     WHERE market = 'KR' AND session_date = $1::date AND source LIKE 'kis:nxt%'
     ORDER BY symbol, observed_at DESC`, [day]);
  const movers = rows
    .filter((row) => Number(row.rate) >= 3)
    .sort((left, right) => right.rate - left.rate)
    .slice(0, 6);

  if (movers.length === 0) return [`  아직 조용합니다 (표본 ${rows.length}종목)`];

  return movers.map((row) => `  ${pct(row.rate)} ${row.name} ${eok(row.turnover)}${row.theme && row.theme !== "미분류" ? ` · ${row.theme}` : ""}`);
}

/*
 * 밤사이 미국에서 나온 재료.
 *
 * 미국 칸에 지수 숫자만 있으면 "어제 미국이 올랐다/내렸다"로 끝납니다. 국내장에
 * 옮겨붙는 것은 지수가 아니라 사건입니다 -- 2026-09-30 새벽 록히드 $297M·$724M,
 * DroneShield $500M, HII 항모 수주가 줄줄이 나왔고, 같은 아침 국내 뉴스에도
 * 1.9조 KF-21 미사일 수주전이 있었습니다. 둘을 같이 보면 오늘 방산이 왜 움직이는지
 * 읽히지만, 따로 보면 우연으로 보입니다.
 *
 * **금액이나 승인이 있는 것만** 고릅니다. 미국 기사는 하루 천 건이 들어오고
 * 그중 대부분이 내부자 매수·부동산·행사 안내입니다. 달러 금액이 적힌 수주와
 * FDA·승인류만 남기면 2026-09-30 새벽에는 열 건 중 넷이 남았습니다.
 */
async function usOvernightNews(config) {
  const { rows } = await query(config, `
    SELECT to_char(published_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at, headline, original_url
      FROM market_news_items
     WHERE region = 'US' AND published_at > now() - interval '14 hours'
       -- \y가 단어 경계입니다. 포스트그레스에서 \b는 백스페이스라 아무것도 안 걸립니다.
       AND (headline ~* '\$[0-9][0-9.,]*\s*(million|billion|[MB]\y)'
            OR headline ~* '(FDA|EMA)\s+(approval|approves|clearance|cleared)'
            OR headline ~* '(awarded|secures|wins)\s+.*(contract|order|deal)')
     ORDER BY published_at DESC LIMIT 12`);
  const seen = new Set();
  const lines = [];

  for (const row of rows) {
    const key = row.headline.replace(/\s/g, "").slice(0, 18).toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);
    lines.push(`  ${row.at} ${row.headline.slice(0, 56)}`);
    const link = cleanUrl(row.original_url);

    if (link) lines.push(`     ${link}`);

    if (seen.size >= 4) break;
  }

  return lines;
}

/* 추적 파라미터는 뗍니다 -- utm_ 셋이 붙으면 URL 하나가 두 줄을 먹습니다. */
function cleanUrl(value) {
  if (!value) return null;

  try {
    const url = new URL(value);

    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "ref") url.searchParams.delete(key);
    }

    return url.toString();
  } catch {
    return value;
  }
}

/*
 * 밤사이 나온 정책·국가 단위 재료.
 *
 * 기존 재료 칸은 **종목 단위 사건만** 봤습니다 -- 수주·공급계약·승인·허가·체결·인수.
 * 그래서 2026-10-01 새벽 05:52 "트럼프, 알래스카 LNG 투자 공식 발표"와 08:06
 * "한미 2000억불 대미투자 팩트시트"가 한 줄도 안 들어갔는데, 그날 아침 프리마켓에서
 * 대한제강이 상한가, 동국제강 +20%, 세아제강 +12%로 제강·강관이 통째로 올랐습니다.
 * 섹터를 통째로 움직이는 재료가 정확히 안 보이던 것입니다.
 *
 * 연결은 짓지 않습니다. "알래스카 LNG니까 강관"은 사람이 하는 판단이고 기계가
 * 하면 틀립니다([[story-links-deferred]], [[leading-theme-detection]]). 여기서는
 * 기사를 그대로 올리고, 바로 아래 프리마켓에서 실제로 오르는 테마를 나란히 둡니다.
 * 둘을 잇는 것은 읽는 사람 몫입니다.
 *
 * 한미약품·한미사이언스는 '한미'에 걸려 들어옵니다. 회사 이름이라 뺍니다.
 * 증권사 의견도 뺍니다 -- "LG CNS, 금융 규제 완화에 매수 의견-다올"이 '규제 완화'로
 * 걸렸는데, 정책이 아니라 그 정책을 두고 쓴 남의 판단입니다.
 */
async function overnightPolicyNews(config) {
  const { rows } = await query(config, `
    SELECT to_char(published_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at, headline, original_url
      FROM market_news_items
     WHERE region = 'KR' AND published_at > now() - interval '17 hours'
       AND headline ~ '관세|반덤핑|쿼터|보조금|세액공제|인허가|규제 완화|법안|한미|대미 ?투자|수출 ?통제|국가전략|정부[^ ]{0,4} ?(지원|발표|추진)'
       AND headline !~ '특징주|급등|급락|강세|약세|마감|증시|코스피|코스닥|개장|리뷰|전망|칼럼|사설|기고|인터뷰|일지|한미약품|한미사이언스|한미글로벌|매수 의견|투자의견|목표가|목표주가|커버리지|리포트'
     ORDER BY published_at DESC LIMIT 12`);
  const seen = new Set();
  const lines = [];

  for (const row of rows) {
    const key = row.headline.replace(/\s/g, "").slice(0, 16);

    if (seen.has(key)) continue;

    seen.add(key);
    lines.push(`  ${row.at} ${row.headline.slice(0, 56)}`);
    const link = cleanUrl(row.original_url);

    if (link) lines.push(`     ${link}`);

    if (seen.size >= 4) break;
  }

  return { keys: seen, lines };
}

/*
 * 프리마켓에서 실제로 돈이 붙는 테마.
 *
 * 종목 여섯 줄만 보면 그것들이 한 덩어리인지 제각각인지 모릅니다. 2026-10-01
 * 아침은 대한제강·동국제강·고려제강·한국철강이 나란히 올랐고 그건 여섯 줄이
 * 아니라 **한 줄짜리 사건**이었습니다.
 *
 * 중앙값이 양수인 테마만 씁니다. 거래대금만 보면 크게 빠진 섹터가 1위로 올라오는
 * 일이 생깁니다 -- 2026년 9월 주도섹터 상위 3칸의 19%가 중앙값 음수였습니다.
 */
async function premarketThemes(config, day) {
  const { rows } = await query(config, `
    SELECT DISTINCT ON (symbol) symbol, theme, change_rate::float8 AS rate, turnover::float8 AS turnover
      FROM market_price_samples
     WHERE market = 'KR' AND session_date = $1::date AND source LIKE 'kis:nxt%'
       AND theme IS NOT NULL AND theme NOT IN ('미분류', 'ETF') AND change_rate IS NOT NULL
     ORDER BY symbol, observed_at DESC`, [day]);
  const byTheme = new Map();

  for (const row of rows) {
    if (Number(row.rate) <= 0) continue;
    if (!byTheme.has(row.theme)) byTheme.set(row.theme, []);
    byTheme.get(row.theme).push(row);
  }

  const groups = [];

  for (const [theme, members] of byTheme) {
    if (members.length < 2) continue;

    const moves = members.map((m) => Number(m.rate)).sort((a, b) => a - b);
    const median = moves[Math.floor(moves.length / 2)];

    if (!(median > 0)) continue;

    groups.push({
      median,
      money: members.reduce((sum, m) => sum + Number(m.turnover ?? 0), 0),
      names: members.sort((a, b) => b.rate - a.rate).slice(0, 3).map((m) => m.symbol),
      size: members.length,
      theme
    });
  }

  return groups
    .sort((left, right) => right.money - left.money)
    .slice(0, 3)
    .map((g) => `  ${g.theme} ${g.size}종목 · 중앙 ${pct(g.median)} · ${eok(g.money)}`);
}

/* 마감 뒤에 나온 재료성 기사. 복기 기사는 뺍니다 -- 오른 것을 다시 쓴 글입니다. */
async function overnightNews(config, alreadyShown = new Set()) {
  const { rows } = await query(config, `
    SELECT to_char(published_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at, headline, original_url
      FROM market_news_items
     WHERE region = 'KR' AND published_at > now() - interval '17 hours'
       AND (headline LIKE '%수주%' OR headline LIKE '%공급계약%' OR headline LIKE '%승인%'
            OR headline LIKE '%허가%' OR headline LIKE '%체결%' OR headline LIKE '%인수%')
       AND headline NOT LIKE '%특징주%' AND headline NOT LIKE '%급등%' AND headline NOT LIKE '%강세%'
     ORDER BY published_at DESC LIMIT 5`);
  const seen = new Set();
  const lines = [];

  for (const row of rows) {
    /* 같은 기사를 여러 매체가 쓰면 제목이 거의 같습니다. 앞 16자로 한 번만 씁니다. */
    const key = row.headline.replace(/\s/g, "").slice(0, 16);

    /* 정책 칸이 이미 쓴 기사. 울산 인허가가 두 칸에 나란히 찍혔습니다. */
    if (seen.has(key) || alreadyShown.has(key)) continue;

    seen.add(key);
    lines.push(`  ${row.at} ${row.headline.slice(0, 58)}`);
    const link = cleanUrl(row.original_url);

    if (link) lines.push(`     ${link}`);
  }

  return lines;
}

/** 절대 던지지 않습니다 -- 알림 때문에 수집 틱이 멈추면 그 분의 분봉을 잃습니다. */
export async function notifyMarketBrief(config, { minute, url } = {}) {
  if (running || !notifyConfigured(config)) return 0;
  if (minute < alertMinute || minute >= stopMinute) return 0;

  const day = sessionDate("KR");

  running = true;

  try {
    if ((await loadAlertSent(config, "market_brief", day)).has("done")) return 0;
    if (!await isKrMarketOpen(config)) {
      await markAlertSent(config, "market_brief", day, "done", { note: "휴장" });

      return 0;
    }

    const yesterday = await yesterdayLines(config, day);
    const lines = [`[아침 시황] ${day}`, ""];
    const macro = await macroLines(config);

    if (macro.length) {
      lines.push("미국 밤사이");
      for (const line of macro) lines.push(`  ${line}`);

      const groups = await usGroupLines(config);

      if (groups.length) {
        lines.push("");
        for (const line of groups) lines.push(line);
      }

      const sectors = await usSectorLines(config).catch(() => []);

      if (sectors.length) {
        lines.push("");
        for (const line of sectors) lines.push(line);
      }

      const usNews = await usOvernightNews(config);

      if (usNews.length) {
        lines.push("");
        lines.push("  밤사이 재료");
        for (const line of usNews) lines.push(`  ${line}`);
      }

      lines.push("");
    }

    if (yesterday.day) {
      lines.push(`어제(${yesterday.day.slice(5)}) 국내장`);
      for (const line of yesterday.lines) lines.push(`  ${line}`);

      const leaders = await yesterdayLeaders(config, yesterday.day);

      if (leaders.length) {
        lines.push(`  많이 오른 것 (거래대금 ${minTurnover / 1e8}억 이상)`);
        for (const line of leaders) lines.push(`  ${line}`);
      }

      lines.push("");
    }

    lines.push("프리마켓");
    for (const line of await premarketLines(config, day)) lines.push(line);

    const themes = await premarketThemes(config, day);

    if (themes.length) {
      lines.push("  — 돈이 붙은 테마");
      for (const line of themes) lines.push(line);
    }

    lines.push("");

    const policy = await overnightPolicyNews(config);

    if (policy.lines.length) {
      lines.push("밤사이 정책·국가 재료");
      for (const line of policy.lines) lines.push(line);
      lines.push("");
    }

    /* 정책 칸이 이미 쓴 기사는 넘기고 받습니다 -- 울산 인허가가 두 칸에 찍혔습니다. */
    const news = await overnightNews(config, policy.keys);

    if (news.length) {
      lines.push("마감 뒤 재료 (종목)");
      for (const line of news) lines.push(line);
      lines.push("");
    }

    lines.push("시황이고 판단이 아닙니다 — 살 것은 [다음 장 후보]가 따로 갑니다.");

    if (!await notify(config, { text: lines.join("\n"), url })) return 0;

    await markAlertSent(config, "market_brief", day, "done", { note: `매크로 ${macro.length}줄 · 정책 ${policy.keys.size}건 · 종목 ${Math.round(news.length / 2)}건` });
    console.log(`알림: 아침 시황 · 매크로 ${macro.length}줄 · 정책 ${policy.keys.size}건 · 종목 ${Math.round(news.length / 2)}건`);

    return 1;
  } catch (error) {
    console.warn("market brief failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}
