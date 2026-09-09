import { loadKrQuotes } from "./kis.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";
import { sessionDate } from "./market-session.mjs";
import { themeFamily } from "./theme-family.mjs";

/**
 * 섹터 대장이 뜬 날, 같은 가족의 2등주를 종가에 사는 후보.
 *
 * 사용자의 규칙을 기계로 옮긴 것입니다. 2026-09-08 한화오션이 아침에 수주 재료로
 * [다음 장 후보]에 떴고 그날 조선이 강했고, 사용자는 조선기자재의 현대힘스를 종가에
 * 사서 다음 날 +4.1% 갭을 먹었습니다. 종가배팅 조건(당일 +5%·회전율 5%·신고점)은
 * 현대힘스를 못 봤습니다 -- -0.75%에 20억이었으니까요. 조건이 보는 것은 그 종목의
 * 모양이고, 사용자가 본 것은 **옆 종목의 재료**였습니다.
 *
 * 그래서 후보를 매일 뽑아 같은 표(kr_signal_outcomes)에 남기고 밤에 채점합니다.
 * 사용자가 손으로 남기는 user_close_bet과 나란히 쌓여, 스무 날쯤 뒤에 "이 규칙이
 * 진짜인가"와 "사람이 고른 것은 기계가 놓친 무엇을 봤나"를 같이 물을 수 있습니다.
 * **지금은 잰 적이 없는 규칙입니다.** 알림에도 그렇게 적습니다.
 *
 *   대장    그날 재료 알림에 뜬 종목. **가격 조건이 없습니다.** 처음엔 "+5% 이상"을
 *           걸었는데 2026-09-08을 되짚으니 한화오션은 그날 -1.37%로 닫았고 조선 사전
 *           여섯 종목이 전부 하락이었습니다 -- 종가로는 섹터가 강한 날이 아니었는데
 *           사용자는 샀고 맞았습니다. 종가 데이터가 못 보는 것(장중 강세·호가)을
 *           조건으로 걸면 그 사례를 영영 못 뽑습니다. 재료가 있었다는 사실만 씁니다
 *   2등주   대장과 같은 테마 가족(theme-family.mjs)의 **사전 회원**을 15:20에 KIS로
 *           직접 물어 거래대금 상위 셋. 표본에서 고르면 안 됩니다 -- 현대힘스는 그날
 *           20억이라 순위 밖이었고 표본이 한 행도 없었습니다(ranking-keyhole-finding).
 *           상한가(27% 이상)만 뺍니다. 내린 종목도 후보입니다 -- 현대힘스가 -0.75%였습니다
 *
 * 되짚기(live=false)는 그날 저장된 일봉으로 같은 계산을 합니다.
 *
 * **이 규칙은 2026-09-08 현대힘스를 뽑지 못합니다.** 되짚으면 한화오션의 2등주로
 * HD현대중공업·삼성중공업(거래대금 1,000억·580억)이 나오고 현대힘스(20억)는 가족 안
 * 13번째입니다. 거래대금으로 고르는 한 사용자가 고른 얇은 종목은 안 나옵니다 --
 * 사용자가 본 것은 호가였고 그건 우리 데이터에 없습니다. 그래서 이 규칙은 사용자
 * 판단의 재현이 아니라 **그 옆에 놓는 대조군**입니다. 같은 표에서 user_close_bet과
 * 나란히 채점되면 "거래대금 상위 2등주"와 "사람이 고른 2등주"의 차이가 숫자로 남습니다.
 *
 * 호가는 보지 않습니다 -- 잔량 데이터가 없습니다. 그것은 사람이 마지막에 봅니다.
 */

const followerMaximumRate = 27;
const followersPerLeader = 3;
const minimumTurnover = 1_000_000_000;
/*
 * 알림에 올리는 문턱. 기록은 전부 남기고(하루 40~50건, 그것이 측정 재료입니다)
 * 알림은 대장이 실제로 오른 날만 보냅니다. 2026-09-08 되짚기에서 재료 종목 28개
 * 전부가 대장으로 잡혀 47줄이 나왔는데, 그중 대부분은 대장이 보합·하락이었습니다.
 * 47줄짜리 알림은 읽히지 않고, 안 읽히면 맞는 날도 같이 묻힙니다.
 */
const alertLeaderMinimumRate = 3;
// 한 대장의 가족을 KIS에 물을 때 상한. 사전 테마가 60~80종목이라 가족 둘이면 150을
// 넘는데, 3.5초 타임아웃 요청을 다섯 개씩 묶어 보내므로 40이면 30초 안입니다.
const familyQuoteLimit = 40;

/**
 * 후보 계산. live면 대장 시세를 KIS에 묻고, 아니면 그날 저장된 값으로 되짚습니다 --
 * 지난 날을 다시 돌려 "그날 뽑혔을까"를 보기 위한 길입니다.
 */
export async function loadSectorFollowers(config, day, { live = true } = {}) {
  const material = await query(config, `
    SELECT DISTINCT symbol FROM kr_signal_outcomes
     WHERE kind LIKE '%material'
       AND (detected_at AT TIME ZONE 'Asia/Seoul')::date = $1::date`, [day]);
  const symbols = material.rows.map((row) => row.symbol);

  if (!symbols.length) return [];

  const leaderRates = live ? await liveRates(config, symbols) : await storedRates(config, day, symbols);
  const context = await query(config, `
    SELECT symbol, max(name) AS name, max(theme) AS theme
      FROM market_price_samples
     WHERE market = 'KR' AND symbol = ANY($1) AND session_date <= $2::date
       AND session_date >= $2::date - 5
     GROUP BY symbol`, [symbols, day]);
  const themeOf = new Map(context.rows.map((row) => [row.symbol, row.theme]));
  const nameOf = new Map(context.rows.map((row) => [row.symbol, row.name]));
  const picks = [];

  for (const symbol of symbols) {
    const family = themeFamily(themeOf.get(symbol));

    if (!family.length) continue;

    const leader = {
      name: nameOf.get(symbol) ?? symbol,
      rate: leaderRates.get(symbol) ?? null,
      symbol,
      theme: themeOf.get(symbol)
    };

    const followers = (await familyQuotes(config, day, family, symbol, { live }))
      .filter((row) => Number.isFinite(row.rate) && row.rate < followerMaximumRate && row.turnover >= minimumTurnover)
      .sort((a, b) => b.turnover - a.turnover)
      .slice(0, followersPerLeader);

    for (const follower of followers) picks.push({ follower, leader });
  }

  return picks;
}

async function liveRates(config, symbols) {
  const quotes = await loadKrQuotes(config, symbols, "J").catch(() => []);

  return new Map(quotes.filter(Boolean).map((quote) => [quote.symbol, Number(quote.changeRateValue)]));
}

async function storedRates(config, day, symbols) {
  const { rows } = await query(config, `
    SELECT symbol, change_rate::float8 AS rate FROM kr_daily_universe
     WHERE session_date = $1::date AND symbol = ANY($2)`, [day, symbols]);

  return new Map(rows.map((row) => [row.symbol, row.rate]));
}

/*
 * 가족 회원의 오늘 값. 사전(kr_theme_members)에서 회원을 뽑고, live면 KIS에 묻고
 * 아니면 그날 일봉을 읽습니다. 표본 라벨(market_price_samples.theme)로 잡히는
 * 종목도 합칩니다 -- 사전에 없지만 우리 분류가 그 라벨을 붙인 것들입니다.
 */
async function familyQuotes(config, day, family, leaderSymbol, { live }) {
  const members = await query(config, `
    SELECT DISTINCT symbol FROM (
      SELECT symbol FROM kr_theme_members WHERE theme_name = ANY($1)
      UNION
      SELECT symbol FROM market_price_samples
       WHERE market = 'KR' AND theme = ANY($1) AND session_date >= $2::date - 5 AND session_date <= $2::date
    ) t WHERE symbol <> $3`, [family, day, leaderSymbol]);
  const symbols = members.rows.map((row) => row.symbol);

  if (!symbols.length) return [];

  if (!live) {
    const { rows } = await query(config, `
      SELECT u.symbol, u.name, u.change_rate::float8 AS rate, u.turnover::float8 AS turnover,
             (SELECT max(theme) FROM market_price_samples p WHERE p.symbol = u.symbol AND p.session_date <= $1::date AND p.session_date >= $1::date - 5) AS theme
        FROM kr_daily_universe u
       WHERE u.session_date = $1::date AND u.symbol = ANY($2)`, [day, symbols]);

    return rows.map((row) => ({ ...row, theme: row.theme ?? family[0] }));
  }

  /* 거래대금이 큰 순으로 상한까지만 묻습니다 -- 어제 유니버스의 거래대금이 순서입니다.
   * 오늘 것은 아직 없고(15:50에 생깁니다), 어제 얇던 종목이 오늘 갑자기 두꺼워지는
   * 일은 드뭅니다. */
  const ordered = await query(config, `
    SELECT DISTINCT ON (symbol) symbol FROM kr_daily_universe
     WHERE symbol = ANY($1) AND session_date < $2::date
     ORDER BY symbol, session_date DESC`, [symbols, day]);
  const byTurnover = await query(config, `
    SELECT symbol FROM kr_daily_universe
     WHERE symbol = ANY($1) AND session_date = (SELECT max(session_date) FROM kr_daily_universe WHERE session_date < $2::date)
     ORDER BY turnover DESC NULLS LAST LIMIT $3`, [ordered.rows.map((row) => row.symbol), day, familyQuoteLimit]);
  const quotes = await loadKrQuotes(config, byTurnover.rows.map((row) => row.symbol), "J").catch(() => []);
  // KIS 시세의 종목명이 장 밖에서 비어 오는 일이 있어 유니버스 이름을 뒤에 둡니다.
  const names = await query(config, `
    SELECT DISTINCT ON (symbol) symbol, name FROM kr_daily_universe
     WHERE symbol = ANY($1) ORDER BY symbol, session_date DESC`, [byTurnover.rows.map((row) => row.symbol)]);
  const nameOf = new Map(names.rows.map((row) => [row.symbol, row.name]));

  return quotes.filter(Boolean).map((quote) => ({
    name: quote.name && quote.name !== quote.symbol ? quote.name : (nameOf.get(quote.symbol) ?? quote.symbol),
    rate: Number(quote.changeRateValue),
    symbol: quote.symbol,
    theme: family[0],
    turnover: Number(quote.turnoverValue ?? 0)
  }));
}

/** 남깁니다. 유일 제약이 하루 한 번을 보장하고, 밤에 nightly-review가 채점합니다. */
export async function recordSectorFollowers(config, day, picks) {
  let saved = 0;

  for (const { follower, leader } of picks) {
    const result = await query(config, `
      INSERT INTO kr_signal_outcomes
        (kind, session_date, symbol, detected_at, tier, theme, entry_rate, leader_symbol, leader_rate, lead_gap)
      VALUES ('sector_follower', $1::date, $2, now(), '2등주', $3, $4, $5, $6, $7)
      ON CONFLICT (kind, session_date, symbol) DO NOTHING`,
      [day, follower.symbol,
        `${leader.name} ${rateLabel(leader.rate)} · ${leader.theme} → ${follower.theme}`.slice(0, 200),
        follower.rate, leader.symbol, leader.rate, leader.rate === null ? null : Number((leader.rate - follower.rate).toFixed(2))]);

    saved += result.rowCount ?? 0;
  }

  return saved;
}

const alertMinute = 15 * 60 + 20;
const stopMinute = 15 * 60 + 32;

let sentDay = null;
let running = false;

export async function notifySectorFollowers(config, { minute, url } = {}) {
  if (running || !notifyConfigured(config)) return 0;
  if (minute < alertMinute || minute >= stopMinute) return 0;

  const day = sessionDate("KR");

  if (sentDay === day) return 0;

  running = true;

  try {
    const picks = await loadSectorFollowers(config, day, { live: true });

    if (!picks.length) return 0;

    // 전부 남깁니다 -- 채점은 알림 여부와 무관하게 다 되어야 규칙을 잴 수 있습니다.
    const saved = await recordSectorFollowers(config, day, picks);
    const worthSending = picks.filter((pick) => Number.isFinite(pick.leader.rate) && pick.leader.rate >= alertLeaderMinimumRate);

    sentDay = day;

    // 대장이 오른 날이 없으면 조용히. 기록은 이미 남았습니다.
    if (!worthSending.length) {
      console.log(`섹터 2등주 · 기록 ${saved}건, 알림 없음(대장 +${alertLeaderMinimumRate}% 이상 없음)`);

      return 0;
    }

    if (!await notify(config, { text: message(worthSending, day), url })) return 0;

    console.log(`알림: 섹터 2등주 · ${worthSending.map((pick) => pick.follower.name).join(", ")} (기록 ${saved})`);

    return worthSending.length;
  } catch (error) {
    console.warn("sector follower alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

const won = (value) => Number(value ?? 0).toLocaleString("ko-KR");
const rateLabel = (rate) => (rate === null || !Number.isFinite(rate) ? "시세 없음" : `${rate > 0 ? "+" : ""}${rate.toFixed(1)}%`);

function message(picks, day) {
  const lines = [`[종가배팅·섹터] ${day} · 오늘 종가에 사는 것 · 후보 ${picks.length}종목`, ""];
  const byLeader = new Map();

  for (const pick of picks) {
    if (!byLeader.has(pick.leader.symbol)) byLeader.set(pick.leader.symbol, { leader: pick.leader, followers: [] });
    byLeader.get(pick.leader.symbol).followers.push(pick.follower);
  }

  for (const { leader, followers } of byLeader.values()) {
    lines.push(`재료 대장 ${leader.name} ${leader.symbol} ${rateLabel(leader.rate)} · ${leader.theme}`);

    for (const follower of followers) {
      lines.push(`  → ${follower.name} ${follower.symbol} ${follower.rate > 0 ? "+" : ""}${follower.rate.toFixed(1)}%`
        + ` · 거래대금 ${won(Math.round(follower.turnover / 1e8))}억 · ${follower.theme}`);
    }

    lines.push("");
  }

  lines.push("※ 대장은 재료가 뜬 종목이고 가격 조건은 없습니다 — 아직 재본 적 없는 규칙(사용자 규칙을 옮긴 것). 호가는 직접 보세요. 청산은 익일 아침.");

  return lines.join("\n");
}
