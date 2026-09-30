import { isKrMarketOpen } from "./kis.mjs";
import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";
import { sessionDate } from "./market-session.mjs";

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

const alertMinute = 8 * 60;
const stopMinute = 8 * 60 + 20;
/* 어제 상위를 셀 때의 거래대금 바닥. 이보다 얇으면 호가 몇 개로 만들어진 등락이라
   "어제 무엇이 갔나"를 왜곡합니다. */
const minTurnover = 3e10;

let running = false;

const pct = (value) => `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
const eok = (won) => `${Math.round(Number(won) / 1e8).toLocaleString("ko-KR")}억`;

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
      FROM b WHERE session_date = (SELECT d FROM last) AND prev > 0`);
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

/* 마감 뒤에 나온 재료성 기사. 복기 기사는 뺍니다 -- 오른 것을 다시 쓴 글입니다. */
async function overnightNews(config) {
  const { rows } = await query(config, `
    SELECT to_char(published_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at, headline
      FROM market_news_items
     WHERE region = 'KR' AND published_at > now() - interval '17 hours'
       AND (headline LIKE '%수주%' OR headline LIKE '%공급계약%' OR headline LIKE '%승인%'
            OR headline LIKE '%허가%' OR headline LIKE '%체결%' OR headline LIKE '%인수%')
       AND headline NOT LIKE '%특징주%' AND headline NOT LIKE '%급등%' AND headline NOT LIKE '%강세%'
     ORDER BY published_at DESC LIMIT 5`);
  const seen = new Set();
  const lines = [];

  for (const row of rows) {
    /* 같은 기사를 여러 매체가 쓰면 제목이 거의 같습니다. 앞 20자로 한 번만 씁니다. */
    const key = row.headline.replace(/\s/g, "").slice(0, 20);

    if (seen.has(key)) continue;

    seen.add(key);
    lines.push(`  ${row.at} ${row.headline.slice(0, 58)}`);
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

    lines.push("프리마켓 (개장 직후)");
    for (const line of await premarketLines(config, day)) lines.push(line);
    lines.push("");

    const news = await overnightNews(config);

    if (news.length) {
      lines.push("마감 뒤 재료");
      for (const line of news) lines.push(line);
      lines.push("");
    }

    lines.push("시황이고 판단이 아닙니다 — 살 것은 [다음 장 후보]가 따로 갑니다.");

    if (!await notify(config, { text: lines.join("\n"), url })) return 0;

    await markAlertSent(config, "market_brief", day, "done", { note: `매크로 ${macro.length}줄 · 재료 ${news.length}건` });
    console.log(`알림: 아침 시황 · 매크로 ${macro.length}줄 · 재료 ${news.length}건`);

    return 1;
  } catch (error) {
    console.warn("market brief failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}
