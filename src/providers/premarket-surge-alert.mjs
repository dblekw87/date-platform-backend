import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { classifyDisclosure, isReasonHeadline } from "./overnight-classify.mjs";
import { query } from "../db/client.mjs";
import { sessionDate } from "./market-session.mjs";

/**
 * 프리마켓(NXT 08:00~08:50)에서 튄 종목.
 *
 * 2026-09-14 영풍이 08:02에 이미 +29.9%였는데 첫 알림은 09:04 정규장 +26.7%였습니다.
 * 상한가 감시는 정규장에서만 돌고, 프리마켓 표본(`kis:nxt`)은 08:00부터 찍히면서도
 * 그것을 읽는 규칙이 없었습니다. 정규장이 열리기 한 시간 전에 이미 답이 나와 있는
 * 종목을 09시에 처음 듣는 셈입니다.
 *
 * 그날 프리마켓에서 +15%를 넘긴 것은 다섯이었고(영풍·일신방직·위메이드맥스·
 * 에스투더블유·위메이드) 다섯 다 정규장에서 강했습니다 -- 하루 다섯 통이면
 * 넘치지 않고, 넘칠 만큼 표본이 쌓이면 문턱을 다시 봅니다.
 *
 * 한 종목에 한 통, 근거는 있으면 붙이고 없어도 보냅니다. 상한가 알림과 반대인
 * 이유: 그쪽은 하루 6~16건 중 절반이 이유 없음이라 기다렸지만, 프리마켓 +15%는
 * 밤새 나온 것에 답한 자리라 대개 이유가 있고, 없어도 "무엇이 튀었는가"가 09시
 * 전에 알아야 할 사실입니다.
 */

const surgeRate = 15;
// 프리마켓 책은 얇습니다. 영풍은 08:02 +29.9%에 5.6억이었고 08:10에 42억이었습니다.
// 2억 아래는 호가 몇 개가 만든 값이라 뺍니다.
const minTurnover = 200_000_000;
const alertIntervalMs = 60_000;

let lastRunAt = 0;
let running = false;

export function preMarketSurgeAlertDue(now = Date.now()) {
  return now - lastRunAt >= alertIntervalMs;
}

export async function notifyPreMarketSurges(config, { url } = {}) {
  if (running || !notifyConfigured(config) || !preMarketSurgeAlertDue()) return 0;

  running = true;
  lastRunAt = Date.now();

  try {
    const day = sessionDate("KR");
    const sent = await loadAlertSent(config, "premarket_surge", day);
    const surges = await loadSurges(config, day);
    let posted = 0;

    for (const stock of surges) {
      if (sent.has(stock.symbol)) {
        posted += await lockFollowUp(config, day, stock, sent.get(stock.symbol), url);
        continue;
      }

      const evidence = await loadEvidence(config, stock.symbol, day);

      if (!await notify(config, { text: message(stock, evidence), url })) continue;

      await markAlertSent(config, "premarket_surge", day, stock.symbol, { note: `${stock.change_rate.toFixed(1)}% ${(stock.turnover / 1e8).toFixed(0)}억` });
      posted += 1;
      console.log(`알림: 프리마켓 급등 · ${stock.name} +${stock.change_rate.toFixed(1)}%`);
    }

    return posted;
  } catch (error) {
    console.warn("premarket surge alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

/*
 * 프리마켓에서 상한가까지 간 종목은 한 번 더.
 *
 * 2026-09-15 이뮨온시아: 08:03 +15.9%로 한 통 나간 뒤 08:33 NXT에서 +29.9%에 닿았는데
 * 두 번째 소식이 없었습니다. 정규장의 상한가 알림은 09:00부터 보고, 이 파일은 종목당
 * 한 통이라 그 사이가 비었습니다. 15%와 29.9%는 다른 사실입니다 -- 프리마켓 상한가는
 * 09:00 시가가 그 값 근처에서 열릴 가능성을 말하고, 그러면 장중 상따 자리는 없습니다.
 * note에 '상한가'가 없을 때만, 한 번.
 */
async function lockFollowUp(config, day, stock, sentRecord, url) {
  if (stock.change_rate < 29.5 || String(sentRecord?.note ?? "").includes("상한가")) return 0;

  const text = [
    `[프리마켓 상한가] ${stock.name} ${stock.symbol}${stock.theme && stock.theme !== "미분류" ? ` · ${stock.theme}` : ""}`,
    `${stock.at} NXT +${stock.change_rate.toFixed(1)}% · 거래대금 ${(stock.turnover / 1e8).toFixed(0)}억 · 첫 알림 ${String(sentRecord?.note ?? "")}`,
    "프리마켓에서 이미 상한가입니다. 09:00 시가가 여기서 열리면 장중에 살 자리는 없고, 시가 상한가는 실측상 익일 시가 +14%p(82%)였던 자리입니다."
  ].join("\n");

  if (!await notify(config, { text, url })) return 0;

  await markAlertSent(config, "premarket_surge", day, stock.symbol, { note: `${String(sentRecord?.note ?? "")} → 상한가 ${stock.at}` });
  console.log(`알림: 프리마켓 상한가 · ${stock.name}`);

  return 1;
}

/* 종목별 마지막 프리마켓 표본. 최고점이 아니라 지금 값을 봅니다 -- 08:05에 +20%
 * 찍고 08:30에 +3%인 종목을 08:30에 급등이라고 보내면 안 됩니다. */
async function loadSurges(config, day) {
  const { rows } = await query(config, `
    SELECT DISTINCT ON (symbol) symbol, name, change_rate::float8, turnover::float8, theme,
           to_char(observed_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at
      FROM market_price_samples
     WHERE market = 'KR' AND session_date = $1::date AND source = 'kis:nxt'
       AND observed_at >= now() - interval '5 minutes'
     ORDER BY symbol, observed_at DESC`, [day]);

  return rows.filter((row) => row.change_rate >= surgeRate && row.turnover >= minTurnover);
}

/*
 * 밤새 나온 것. 직전 장 마감(15:30) 뒤부터 지금까지 -- 프리마켓 급등의 이유는 그
 * 사이에 있습니다. 공시는 재료 선정과 같은 분류, 기사는 같은 복기 체를 씁니다.
 */
async function loadEvidence(config, symbol, day) {
  const from = await query(config, `
    SELECT max(session_date) AS previous FROM kr_daily_universe WHERE session_date < $1::date`, [day]);
  const previous = from.rows[0]?.previous ?? day;
  const since = new Date(`${new Date(previous).toISOString().slice(0, 10)}T15:30:00+09:00`);

  const filed = await query(config, `
    SELECT to_char(filed_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') AS at, report_name, title, original_url
      FROM market_disclosures
     WHERE market = 'KR' AND symbol = $1 AND filed_at >= $2
     ORDER BY filed_at DESC`, [symbol, since]);
  const filings = filed.rows.filter((row) => classifyDisclosure(row.report_name, row.title) === "good");

  const news = await query(config, `
    SELECT DISTINCT ON (left(regexp_replace(lower(headline), '[^가-힣a-z0-9]', '', 'g'), 30))
           to_char(published_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') AS at, headline, original_url, published_at
      FROM market_news_items, LATERAL unnest(related_symbols) s
     WHERE region = 'KR' AND s = $1 AND published_at >= $2
     ORDER BY left(regexp_replace(lower(headline), '[^가-힣a-z0-9]', '', 'g'), 30), published_at DESC`, [symbol, since]);
  const reasons = news.rows
    .filter((row) => isReasonHeadline(row.headline))
    .sort((a, b) => b.published_at - a.published_at);

  return { filings: filings.slice(0, 2), news: reasons.slice(0, 2) };
}

function message(stock, evidence) {
  const theme = stock.theme && stock.theme !== "미분류" ? ` · ${stock.theme}` : "";
  const lines = [
    `[프리마켓 급등] ${stock.name} ${stock.symbol}${theme}`,
    `${stock.at} NXT +${stock.change_rate.toFixed(1)}% · 거래대금 ${(stock.turnover / 1e8).toFixed(0)}억`
  ];

  for (const filing of evidence.filings) {
    lines.push(`  공시 ${filing.at} ${String(filing.title).split("·").pop().trim()}`);
    if (filing.original_url) lines.push(`       ${filing.original_url}`);
  }

  for (const article of evidence.news) {
    lines.push(`  뉴스 ${article.at} ${article.headline}`);
    if (article.original_url) lines.push(`       ${article.original_url}`);
  }

  if (!evidence.filings.length && !evidence.news.length) lines.push("  밤새 공시·기사 없음 -- 이유 모름");

  lines.push("프리마켓은 NXT 책만 열려 있어 얇습니다. 09:00 시가와 다를 수 있습니다.");

  return lines.join("\n");
}
