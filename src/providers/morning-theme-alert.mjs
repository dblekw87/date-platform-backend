import { customThemeGroups } from "./custom-theme-groups.mjs";
import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";
import { sessionDate } from "./market-session.mjs";
import { sessionsAsOf, upcomingWindow } from "./overnight-window.mjs";
import { themeHits } from "./theme-spread.mjs";

/**
 * 07:35 아침 테마 재료: 밤사이 기사 중 **테마 전체를 가리키는 것**을 테마별로 묶어 한 통.
 *
 * 2026-11-26: 01:55 FCC가 스페이스X 위성 100만 기를 승인했고 04:56엔 "스페이스X 위성 100만기
 * 승인…한국항공우주·한화시스템 우주산업 날개"가 나왔습니다. 그날 우주주(미래에셋벤처투자 +21,
 * 나라스페이스 +17, 스피어 +15, AP위성 +10)가 장 시작부터 뛰었는데, 재료 알림은 종목 단위라
 * 05:00에 대형주 둘(C등급)만 갔습니다. 사용자: "나라스페이스는 수주 재료도 있었지만, 전체적으로
 * 우주가 오를 것이라는 판단을 할 수 있는 테마성 재료도 띄워 줘야 돼 … 아침 시황으로 알려 주면
 * 장 전에 판단이 가능하니까."
 *
 * 묶는 법:
 *   1. 직전 장 15:40 뒤 국내 기사 제목 전부("관련주" 같은 말이 없는 美 기업 소식 — "FCC, 스페이스X 위성
 *      100만기 승인" — 도 테마를 가리킵니다).
 *   2. 네이버 테마 사전(kr_theme_members)의 이름과 제목을 맞춥니다(theme-spread.mjs의 themeHits —
 *      종목명·그룹명·흔한 동사는 지움). **이름으로 테마를 추정하지 않습니다.**
 *   3. 매일 나오는 테마(반도체·2차전지)가 늘 맨 위를 차지하지 않도록, 직전 5일 같은 창의 평균
 *      건수를 빼서 **오늘 새로 늘어난 것** 순으로 세웁니다.
 *
 * 사라는 알림이 아닙니다. 성적은 아직 재 본 적이 없습니다.
 */

const kind = "morning_theme";
const startMinute = 7 * 60 + 35;
const stopMinute = 7 * 60 + 50;
const themeLimit = 5;
const memberLimit = 6;
const baselineNights = 5;

let running = false;

export function morningThemeDue(minute) {
  return minute >= startMinute && minute < stopMinute;
}

export async function notifyMorningThemes(config, { minute, url } = {}) {
  if (running || !notifyConfigured(config) || !morningThemeDue(minute)) return 0;

  const today = sessionDate("KR");
  const weekday = new Date(`${today}T12:00:00+09:00`).getUTCDay();

  if (weekday === 0 || weekday === 6) return 0;

  running = true;

  try {
    if ((await loadAlertSent(config, kind, today)).has("done")) return 0;

    const window = upcomingWindow(await sessionsAsOf(config));
    const themes = await loadMorningThemes(config, { from: window.from, previous: window.previous, to: new Date() });
    const carried = await loadYesterdayIntradayThemes(config, window.previous).catch(() => []);

    if (!themes.length && !carried.length) {
      await markAlertSent(config, kind, today, "done", { note: "테마 재료 없음" });

      return 0;
    }

    const ok = await notify(config, { text: morningThemeMessage(today, themes, carried), url });

    if (!ok) return 0;

    await markAlertSent(config, kind, today, "done", { note: themes.map((item) => item.theme).join(", ").slice(0, 200) });
    console.log(`알림: 아침 테마 재료 · ${themes.map((item) => item.theme).join(", ")}`);

    return themes.length;
  } catch (error) {
    console.warn("morning theme alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

const dayMs = 86_400_000;

export async function loadMorningThemes(config, { from, previous, to }) {
  const baselineFrom = new Date(from.getTime() - baselineNights * dayMs);
  const { rows: articles } = await query(config, `
    SELECT published_at, headline FROM market_news_items
     WHERE published_at >= $1 AND published_at <= $2
       AND headline ~ '[가-힣]'
     ORDER BY published_at`, [baselineFrom, to]);
  const { rows: themeRows } = await query(config, `SELECT DISTINCT theme_name FROM kr_theme_members`);
  // 제목에서 지울 종목 이름. 세 글자 미만은 낱말과 겹쳐(태양·대상) 지우지 않습니다.
  const { rows: nameRows } = await query(config, `
    SELECT DISTINCT name FROM kr_daily_universe
     WHERE session_date = (SELECT max(session_date) FROM kr_daily_universe WHERE session_date <= $1::date)
       AND length(name) >= 3`, [previous]);
  const names = nameRows.map((row) => row.name);
  const themeNames = themeRows.map((row) => row.theme_name);
  const seen = new Set();
  const tonight = new Map();
  const baseline = new Map();

  for (const article of articles) {
    const key = article.headline.replace(/\s+/g, "").slice(0, 40);

    if (seen.has(key)) continue;
    seen.add(key);

    const present = names.filter((name) => article.headline.includes(name));
    const scored = themeNames
      .map((theme) => ({ hits: themeHits(theme, article.headline, present), theme }))
      .filter((item) => item.hits > 0);
    // 맞은 테마 전부에 셉니다. "스페이스X 위성"은 '스페이스X'와 '우주항공' 둘 다이고, 매일 걸리는
    // 테마는 기준선이 걸러 냅니다.
    const best = scored;

    if (!best.length) continue;

    const at = new Date(article.published_at);

    for (const { theme } of best) {
      // 오늘 밤 창이 아니면 며칠 전 같은 시간대(15:40~지금 시각)에 든 것만 기준선으로 셉니다.
      if (at >= from) {
        if (!tonight.has(theme)) tonight.set(theme, []);
        tonight.get(theme).push({ at, headline: article.headline });
      } else {
        const offset = Math.ceil((from - at) / dayMs);
        const nightFrom = new Date(from.getTime() - offset * dayMs);
        const nightTo = new Date(to.getTime() - offset * dayMs);

        if (at >= nightFrom && at <= nightTo) baseline.set(theme, (baseline.get(theme) ?? 0) + 1);
      }
    }
  }

  const ranked = [...tonight.entries()]
    /* 평소 대비 몇 배인가. 더하기 2는 평소 0건인 테마가 기사 두 건으로 맨 위에 오르지 않게 하는 완충입니다. */
    .map(([theme, items]) => {
      const usual = (baseline.get(theme) ?? 0) / baselineNights;

      const rise = (items.length - usual) / (usual + 2);

      /* 배수만 보면 기사 몇 건짜리 낱말 우연(마이크로 LED → 마이크로바이옴)이 위로 옵니다.
         건수 × 배수로 세우고 바닥을 둡니다(11/26 시험: 스페이스X 30건×2.4, 우주태양광 27×1.7). */
      return { items, rise, score: items.length * rise, theme };
    })
    .filter((item) => item.items.length >= 5 && item.rise >= 1 && item.score >= 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, themeLimit);

  if (!ranked.length) return [];

  const { rows: members } = await query(config, `
    SELECT m.theme_name, u.name, u.turnover::float8 AS turnover, u.change_rate::float8 AS change_rate
      FROM kr_theme_members m
      JOIN kr_daily_universe u ON u.symbol = m.symbol
       AND u.session_date = (SELECT max(session_date) FROM kr_daily_universe WHERE session_date <= $2::date)
     WHERE m.theme_name = ANY($1) AND coalesce(u.trade_halted, false) = false
     ORDER BY u.turnover DESC NULLS LAST`, [ranked.map((item) => item.theme), previous]);

  return ranked.map((item) => ({
    ...item,
    baseline: (baseline.get(item.theme) ?? 0) / baselineNights,
    members: members.filter((row) => row.theme_name === item.theme).slice(0, memberLimit)
  }));
}

const clock = (date) => date.toLocaleTimeString("ko-KR", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: "Asia/Seoul" });

/*
 * 어제 장중에 보낸 테마 재료를 다시 적습니다.
 *
 * 사용자(11/26): "장중에 나왔는데 다음날 오른 것도 있어, 하락장이었을 때고." 같은 재료가
 * 상승장에선 묻혔다가 다음 하락장에 다시 켜지는 일이 있었습니다(화장품 한중 FTA: 11/24 상승장
 * 초과 +1.2뿐 → 11/25 하락장 쏠림 1위, memory trader-brain). 장중 알림은 하루 한 번이라 그 다음
 * 날엔 아무도 다시 말해 주지 않습니다. 어제 종가 등락을 같이 적어 "어제 얼마나 반영됐나"를 봅니다.
 */
export async function loadYesterdayIntradayThemes(config, previous) {
  const sent = await loadAlertSent(config, "intraday_theme", previous);

  if (!sent.size) return [];

  const themes = [...sent.keys()];
  const { rows } = await query(config, `
    SELECT theme_name, symbol FROM kr_theme_members WHERE theme_name = ANY($1)`, [themes]);
  const symbolsOf = new Map(themes.map((theme) => [theme, Array.isArray(customThemeGroups[theme]) ? [...customThemeGroups[theme]] : []]));

  for (const row of rows) symbolsOf.get(row.theme_name)?.push(row.symbol);

  const { rows: bars } = await query(config, `
    SELECT symbol, name, change_rate::float8 AS change_rate, turnover::float8 AS turnover
      FROM kr_daily_universe WHERE session_date = $1::date AND symbol = ANY($2)`, [previous, [...new Set([...symbolsOf.values()].flat())]]);
  const barOf = new Map(bars.map((row) => [row.symbol, row]));

  return themes.map((theme) => {
    const members = (symbolsOf.get(theme) ?? []).map((symbol) => barOf.get(symbol)).filter(Boolean)
      .sort((a, b) => (b.turnover ?? 0) - (a.turnover ?? 0));

    return {
      at: sent.get(theme).sentAt,
      headline: sent.get(theme).note,
      members: members.slice(0, 4),
      theme
    };
  });
}

export function morningThemeMessage(day, themes, carried = []) {
  const weekday = new Date(`${day}T12:00:00+09:00`).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" });
  const lines = [`[아침 테마 재료] ${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}(${weekday}) · 밤사이 테마 전체를 가리킨 기사`, ""];

  themes.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.theme} — 기사 ${item.items.length}건(평소 ${item.baseline.toFixed(1)}) · 첫 ${clock(item.items[0].at)}`);

    for (const article of item.items.slice(-2)) lines.push(`   ${clock(article.at)} ${article.headline.slice(0, 70)}`);

    if (item.members.length) {
      lines.push(`   종목(어제 거래대금 순): ${item.members.map((row) => `${row.name} ${row.change_rate >= 0 ? "+" : ""}${Number(row.change_rate).toFixed(1)}%`).join(" · ")}`);
    }

    lines.push("");
  });

  if (carried.length) {
    lines.push("어제 장중에 뜬 테마 재료(하락장엔 다음 날 다시 켜지는 일이 있었음):");

    for (const item of carried) {
      const moves = item.members.map((row) => `${row.name} ${row.change_rate >= 0 ? "+" : ""}${Number(row.change_rate).toFixed(1)}%`).join(" · ");

      lines.push(`· ${item.theme} (${clock(new Date(item.at))})${moves ? ` — 어제 종가 ${moves}` : ""}`);
      if (item.headline) lines.push(`   ${String(item.headline).slice(0, 70)}`);
    }

    lines.push("");
  }

  lines.push("네이버 테마 사전과 기사 제목을 맞춘 것입니다(이름 추정 아님). 사라는 알림이 아니고, 성적은 아직 재 본 적이 없습니다.");

  return lines.join("\n");
}
