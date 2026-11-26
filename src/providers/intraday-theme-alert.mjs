import { customThemeGroups } from "./custom-theme-groups.mjs";
import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";
import { sessionDate } from "./market-session.mjs";
import { themeHits } from "./theme-spread.mjs";

/**
 * 장중 테마 재료: 최근 한 시간 기사 중 테마 전체를 가리키는 것이 평소보다 몰리면 한 통.
 *
 * 아침 07:35 알림(morning-theme-alert.mjs)과 같은 생각을 장중 창에 씁니다. 사용자(11/26):
 * "장중에도 테마 재료가 나오면 텔레그램으로 쏴 줘, 호남 같은 경우엔 장중에 떴을 때도 있었거든."
 * 11/13 '반도체 호남 시대' 기사는 09:06부터였고 금호건설은 그날 상한가였습니다.
 *
 * 창은 최근 60분, 기준선은 직전 다섯 평일의 같은 60분입니다. 테마 하나는 하루 한 번만 보냅니다 --
 * 이미 받은 테마를 또 받으면 새 것이 묻힙니다. 15분마다 보고, 한 통에 세 테마까지.
 *
 * 손 묶음(custom-theme-groups)도 봅니다. 네이버 사전엔 지역 테마가 없어서 그 묶음 이름의
 * 지역 낱말로만 맞춥니다(호남·충청·영남은 제목에 그 낱말이 있어야 함 -- '광주'만으로는
 * 지역 행정 기사가 매일 나와 잡음).
 *
 * 사라는 알림이 아닙니다. 장중 매매 판단은 사용자가 합니다. 성적은 아직 재 본 적이 없습니다.
 */

const kind = "intraday_theme";
const startMinute = 9 * 60 + 10;
const stopMinute = 15 * 60 + 20;
const intervalMs = 15 * 60_000;
const windowMs = 60 * 60_000;
const dayMs = 86_400_000;
const baselineDays = 5;
const themeLimit = 3;
const memberLimit = 6;

/* 손 묶음을 가리키는 낱말. 묶음 이름의 앞말이고, 기사가 그 묶음을 부를 때 실제로 쓰는 말입니다. */
const handKeywords = {
  "소캠 소부장(삼전닉스 제외)": ["소캠", "SOCAMM"],
  "엔터(기획사·팬덤)": ["엔터주", "기획사", "K팝", "케이팝"],
  "영남(가덕도·부산)": ["가덕도", "가덕신공항"],
  "창투사 대장(11/13 급등)": ["창투사", "벤처캐피탈", "벤처투자"],
  "충청(세종 행정수도)": ["행정수도", "세종시 이전"],
  "호남(반도체 클러스터)": ["호남", "전남광주", "광주·전남"]
};

/* 제목이 종목 하나가 아니라 무리를 부르는 말. 장중엔 "○○株 들썩", "[특징주] ○○ 테마 상승세" 꼴이
   테마가 실제로 움직였다는 가장 직접적인 신호라, 이 꼴이 두 건 넘어야 보냅니다(11/25~26 시험에서
   이 조건 없이는 하루 11~12통, 테마 20~30개 -- 대부분 낱말 우연). */
const groupPattern = /관련주|테마|株|수혜주|동반 (강세|급등|상승)|주(가)? (급등|강세|들썩)|들썩|일제히/;

let lastRunAt = 0;
let running = false;

export function intradayThemeDue(minute, now = Date.now()) {
  return minute >= startMinute && minute < stopMinute && now - lastRunAt >= intervalMs;
}

export async function notifyIntradayThemes(config, { minute, url } = {}) {
  if (running || !notifyConfigured(config) || !intradayThemeDue(minute)) return 0;

  running = true;
  lastRunAt = Date.now();

  try {
    const day = sessionDate("KR");
    const sent = await loadAlertSent(config, kind, day);
    const themes = (await loadIntradayThemes(config, { day, to: new Date() }))
      .filter((item) => !sent.has(item.theme))
      .slice(0, themeLimit);

    if (!themes.length) return 0;

    const ok = await notify(config, { text: intradayThemeMessage(themes), url });

    if (!ok) return 0;

    for (const item of themes) await markAlertSent(config, kind, day, item.theme, { note: item.items[0]?.headline?.slice(0, 200) ?? null });
    console.log(`알림: 장중 테마 재료 · ${themes.map((item) => item.theme).join(", ")}`);

    return themes.length;
  } catch (error) {
    console.warn("intraday theme alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

/** 기준선으로 쓸 직전 평일 다섯 날의 같은 창(끝 시각). */
function baselineEnds(to) {
  const ends = [];

  for (let k = 1; ends.length < baselineDays && k <= 10; k += 1) {
    const end = new Date(to.getTime() - k * dayMs);
    const weekday = new Date(end.getTime() + 9 * 3_600_000).getUTCDay();

    if (weekday !== 0 && weekday !== 6) ends.push(end);
  }

  return ends;
}

export async function loadIntradayThemes(config, { day, to }) {
  const ends = [to, ...baselineEnds(to)];
  const { rows: articles } = await query(config, `
    SELECT published_at, headline FROM market_news_items
     WHERE headline ~ '[가-힣]'
       AND (${ends.map((_, index) => `(published_at > $${index * 2 + 1} AND published_at <= $${index * 2 + 2})`).join(" OR ")})
     ORDER BY published_at`, ends.flatMap((end) => [new Date(end.getTime() - windowMs), end]));
  const { rows: themeRows } = await query(config, `SELECT DISTINCT theme_name FROM kr_theme_members`);
  const { rows: nameRows } = await query(config, `
    SELECT DISTINCT name FROM kr_daily_universe
     WHERE session_date = (SELECT max(session_date) FROM kr_daily_universe WHERE session_date < $1::date)
       AND length(name) >= 3`, [day]);
  const names = nameRows.map((row) => row.name);
  const themeNames = themeRows.map((row) => row.theme_name);
  const windowFrom = new Date(to.getTime() - windowMs);
  const seen = new Set();
  const now = new Map();
  const usual = new Map();

  for (const article of articles) {
    const key = article.headline.replace(/\s+/g, "").slice(0, 40);

    if (seen.has(key)) continue;
    seen.add(key);

    const present = names.filter((name) => article.headline.includes(name));
    const matched = themeNames.filter((theme) => themeHits(theme, article.headline, present) > 0);

    for (const [group, keywords] of Object.entries(handKeywords)) {
      if (keywords.some((word) => article.headline.includes(word))) matched.push(group);
    }

    const at = new Date(article.published_at);

    for (const theme of matched) {
      if (at > windowFrom) {
        if (!now.has(theme)) now.set(theme, []);
        now.get(theme).push({ at, headline: article.headline });
      } else {
        usual.set(theme, (usual.get(theme) ?? 0) + 1);
      }
    }
  }

  const ranked = [...now.entries()]
    .map(([theme, items]) => {
      const base = (usual.get(theme) ?? 0) / baselineDays;
      const rise = (items.length - base) / (base + 1);

      return { baseline: base, items, rise, score: items.length * rise, theme };
    })
    /* 한 시간 창이라 건수가 작습니다: 세 건 이상, 평소의 두 배를 넘고, 점수 9 이상,
       그리고 무리를 부르는 제목이 둘 이상. */
    .filter((item) => handKeywords[item.theme]
      /* 손 묶음은 지역·업권 낱말 자체가 테마를 부르는 말이라("반도체 호남 시대") 꼴을 따지지 않고
         두 건·평소 두 배만 봅니다. 11/13 호남은 이 꼴 조건에 걸려 빠졌습니다. */
      ? (item.items.length >= 2 && item.rise >= 2) || (item.items.length >= 3 && item.rise >= 1)
      : item.items.length >= 3 && item.rise >= 2 && item.score >= 9
        && item.items.filter((article) => groupPattern.test(article.headline)).length >= 2)
    .sort((a, b) => b.score - a.score)
    /* 같은 기사들로 걸린 이웃 테마(2차전지·2차전지(LFP)·2차전지(나트륨))는 점수 높은 하나만. */
    .filter((item, index, list) => {
      const key = item.items.map((article) => article.headline).sort().join("|");

      return list.findIndex((other) => other.items.map((article) => article.headline).sort().join("|") === key) === index;
    });

  if (!ranked.length) return [];

  const dictionary = ranked.map((item) => item.theme).filter((theme) => !handKeywords[theme]);
  const { rows: members } = await query(config, `
    SELECT m.theme_name, m.symbol FROM kr_theme_members m WHERE m.theme_name = ANY($1)`, [dictionary]);
  const symbolsOf = new Map();

  for (const row of members) {
    if (!symbolsOf.has(row.theme_name)) symbolsOf.set(row.theme_name, []);
    symbolsOf.get(row.theme_name).push(row.symbol);
  }

  for (const item of ranked) {
    const hand = customThemeGroups[item.theme];

    if (Array.isArray(hand)) symbolsOf.set(item.theme, hand);
  }

  const allSymbols = [...new Set([...symbolsOf.values()].flat())];
  // 지금 값. 장중이라 오늘 거래대금이 몰린 순으로 세웁니다.
  const { rows: live } = await query(config, `
    SELECT DISTINCT ON (s.symbol) s.symbol, coalesce(u.name, s.symbol) AS name, s.change_rate::float8 AS change_rate, s.turnover::float8 AS turnover
      FROM market_price_samples s
      LEFT JOIN kr_daily_universe u ON u.symbol = s.symbol
       AND u.session_date = (SELECT max(session_date) FROM kr_daily_universe WHERE session_date < $2::date)
     WHERE s.market = 'KR' AND s.session_date = $2::date AND s.symbol = ANY($1) AND s.source LIKE 'kis:krx%'
     ORDER BY s.symbol, s.observed_at DESC`, [allSymbols, day]);
  const liveBy = new Map(live.map((row) => [row.symbol, row]));

  return ranked.map((item) => ({
    ...item,
    members: (symbolsOf.get(item.theme) ?? [])
      .map((symbol) => liveBy.get(symbol))
      .filter(Boolean)
      .sort((a, b) => (b.turnover ?? 0) - (a.turnover ?? 0))
      .slice(0, memberLimit)
  }));
}

const clock = (date) => date.toLocaleTimeString("ko-KR", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: "Asia/Seoul" });

export function intradayThemeMessage(themes) {
  const lines = [`[장중 테마 재료] 최근 1시간 기사가 평소보다 몰린 테마 ${themes.length}개`, ""];

  for (const item of themes) {
    lines.push(`■ ${item.theme} — 기사 ${item.items.length}건(평소 ${item.baseline.toFixed(1)}) · 첫 ${clock(item.items[0].at)}`);

    const shown = [...item.items.filter((article) => groupPattern.test(article.headline)), ...item.items].slice(0, 2);

    for (const article of shown) lines.push(`   ${clock(article.at)} ${article.headline.slice(0, 70)}`);

    if (item.members.length) {
      lines.push(`   지금(오늘 거래대금 순): ${item.members.map((row) => `${row.name} ${row.change_rate >= 0 ? "+" : ""}${Number(row.change_rate).toFixed(1)}%`).join(" · ")}`);
    }

    lines.push("");
  }

  lines.push("테마마다 하루 한 번만 보냅니다. 사라는 알림이 아니고, 성적은 아직 재 본 적이 없습니다.");

  return lines.join("\n");
}
