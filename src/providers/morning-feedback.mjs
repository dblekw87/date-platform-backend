import { readFile } from "node:fs/promises";

import { query } from "../db/client.mjs";
import { isKrMarketOpen } from "./kis.mjs";
import { sessionDate } from "./market-session.mjs";
import { notify, notifyConfigured } from "./notify.mjs";

/**
 * 아침 피드백 -- 어제와 그저께의 판단을 한 통으로.
 *
 * 사용자는 08:00까지 출근해 08:30쯤 처음 봅니다(2026-09-10). 그때 필요한 것은
 * 둘입니다: 어제 종가에 들어간 것이 무엇이었는지(오늘 09:05~09:10에 판다), 그리고
 * 그 전날 판단이 어떻게 됐는지. 채점은 다음 거래일 봉이 들어온 15:55에
 * nightly-review가 하므로, 07:00에 채점이 끝나 있는 것은 그저께 판단입니다.
 *
 * 사람의 판단(user_close_bet)을 맨 위에 둡니다 -- 이 알림이 있는 이유라서입니다.
 * 기계 후보(close_bet·sector_follower)와 나머지 신호는 전부 "종가에 샀다면"이라는
 * 같은 자로 잽니다: 다음날 시가 갭에서 그날 밤 시장 평균 갭을 뺀 초과분. 짝꿍이나
 * 상한가는 장중에 잡히는 신호지만 등급이 종가매수 전용으로 재어졌으니
 * ([[pair-intraday-verdict]]) 같은 자가 맞습니다.
 *
 * 날짜를 달력으로 세지 않습니다. "채점이 끝난 가장 최근 장"과 "기록이 있는 가장 최근
 * 장"을 표에서 읽으므로 월요일 아침이면 저절로 목·금이 됩니다.
 */

const alertMinute = 7 * 60;
const stopMinute = 7 * 60 + 15;

const kinds = [
  { kind: "user_close_bet", label: "사람" },
  { kind: "close_bet", label: "종가배팅" },
  { kind: "offhigh_close_bet", label: "재료(미돌파)" },
  { kind: "sector_follower", label: "섹터 대조군" },
  { kind: "limit_up", label: "상한가" },
  { kind: "limit_pair", label: "짝꿍" },
  { kind: "overnight_material", label: "밤 재료" },
  { kind: "intraday_material", label: "장중 재료" }
];
// 종가에 실제로 사는 셋은 종목까지 적고, 나머지는 건수와 평균만 적습니다.
const listedKinds = new Set(["close_bet", "offhigh_close_bet", "sector_follower", "user_close_bet"]);

let sentDay = null;
let running = false;

export async function notifyMorningFeedback(config, { minute, url } = {}) {
  if (running || !notifyConfigured(config)) return 0;
  if (minute < alertMinute || minute >= stopMinute) return 0;

  const day = sessionDate("KR");

  if (sentDay === day) return 0;

  running = true;

  try {
    // 휴장일 아침에는 새로 들어간 것도 채점된 것도 없습니다.
    if (!await isKrMarketOpen(config)) {
      sentDay = day;

      return 0;
    }

    const text = await buildMorningFeedback(config, { day });

    sentDay = day;

    if (!await notify(config, { text, url })) return 0;

    console.log(`알림: 아침 피드백 · ${day}`);

    return 1;
  } catch (error) {
    console.warn("morning feedback failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

export async function buildMorningFeedback(config, { day = sessionDate("KR") } = {}) {
  const [graded, entered, cumulative, reminders] = await Promise.all([
    loadGraded(config),
    loadEntered(config),
    loadCumulative(config),
    loadReminders(day)
  ]);

  return message({ cumulative, day, entered, graded, reminders });
}

/**
 * 날짜를 박아둔 메모 -- `reminders.json`(저장소 루트)에서 오늘 것만.
 *
 * "9월 14일에 알려줘" 같은 부탁을 둘 곳입니다. 사용자는 아침 알림을 08:30에
 * 읽으니 그 통에 얹는 것이 따로 보내는 것보다 확실합니다. 파일이 없거나
 * 깨져 있어도 피드백은 나가야 하므로 빈 목록으로 넘어갑니다.
 */
async function loadReminders(day) {
  try {
    const items = JSON.parse(await readFile("reminders.json", "utf8"));

    return items.filter((item) => item?.date === day && item.text).map((item) => item.text);
  } catch {
    return [];
  }
}

/** 채점이 끝난 가장 최근 장의 신호 전부, 종가 기준 갭과 함께. */
async function loadGraded(config) {
  const { rows } = await query(config, `
    WITH latest AS (
      SELECT max(session_date) AS day FROM kr_signal_outcomes
       WHERE scored_at IS NOT NULL AND next_open IS NOT NULL
    )
    SELECT o.kind, o.symbol, o.tier, o.theme,
           o.session_date::text AS day,
           o.entry_rate::float8 AS entry_rate,
           b.close::float8 AS close,
           ((o.next_open / nullif(b.close, 0) - 1) * 100)::float8 AS gap,
           ((o.next_close / nullif(b.close, 0) - 1) * 100)::float8 AS to_close,
           o.market_next_open::float8 AS market_gap,
           u.name
      FROM kr_signal_outcomes o
      JOIN latest l ON o.session_date = l.day
      LEFT JOIN kr_daily_bars b ON b.symbol = o.symbol AND b.session_date = o.session_date
      LEFT JOIN LATERAL (
        SELECT name FROM kr_daily_universe u
         WHERE u.symbol = o.symbol ORDER BY u.session_date DESC LIMIT 1
      ) u ON true
     WHERE o.scored_at IS NOT NULL AND o.next_open IS NOT NULL
     ORDER BY o.kind, o.symbol`);

  return rows;
}

/** 기록이 있는 가장 최근 장 -- 보통 어제 -- 에 들어간 것. 아직 채점 전입니다. */
async function loadEntered(config) {
  const { rows } = await query(config, `
    WITH latest AS (SELECT max(session_date) AS day FROM kr_signal_outcomes)
    SELECT o.kind, o.symbol, o.tier, o.theme,
           o.session_date::text AS day,
           o.entry_rate::float8 AS entry_rate,
           u.name, u.close_price::float8 AS close, u.change_rate::float8 AS change_rate
      FROM kr_signal_outcomes o
      JOIN latest l ON o.session_date = l.day
      LEFT JOIN kr_daily_universe u ON u.symbol = o.symbol AND u.session_date = o.session_date
     ORDER BY o.kind, o.symbol`);

  return rows;
}

/** kind별 누적 -- 채점된 것만. */
async function loadCumulative(config) {
  const { rows } = await query(config, `
    SELECT o.kind, count(*)::int AS n,
           count(*) FILTER (WHERE (o.next_open / nullif(b.close, 0) - 1) * 100 - o.market_next_open > 0)::int AS beat,
           avg((o.next_open / nullif(b.close, 0) - 1) * 100 - o.market_next_open)::float8 AS excess
      FROM kr_signal_outcomes o
      JOIN kr_daily_bars b ON b.symbol = o.symbol AND b.session_date = o.session_date
     WHERE o.scored_at IS NOT NULL AND o.next_open IS NOT NULL
       AND b.close > 0 AND o.market_next_open IS NOT NULL
     GROUP BY o.kind`);

  return new Map(rows.map((row) => [row.kind, row]));
}

const weekday = ["일", "월", "화", "수", "목", "금", "토"];
const dayLabel = (day) => `${day.slice(5)}(${weekday[new Date(`${day}T00:00:00+09:00`).getDay()]})`;
const signed = (value, digits = 1) => (Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(digits)}` : "—");
const won = (value) => (Number.isFinite(value) ? `${Math.round(value).toLocaleString("ko-KR")}원` : "봉 없음");
const average = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN);

function message({ cumulative, day, entered, graded, reminders = [] }) {
  const lines = [`[아침 피드백] ${dayLabel(day)}`, ""];

  if (reminders.length) {
    lines.push("■ 오늘 메모");
    reminders.forEach((text) => lines.push(`  ${text}`));
    lines.push("");
  }

  lines.push(...gradedSection(graded));
  lines.push("");
  lines.push(...enteredSection(entered));
  lines.push("");
  lines.push(...cumulativeSection(cumulative));

  return lines.join("\n");
}

function gradedSection(rows) {
  if (!rows.length) return ["■ 채점된 판단이 아직 없습니다"];

  const day = rows[0].day;
  const marketGap = rows.find((row) => Number.isFinite(row.market_gap))?.market_gap;
  const lines = [`■ ${dayLabel(day)} 판단 채점 · 종가 매수 → 다음 장 시가 · 시장 갭 ${signed(marketGap)}%`];

  for (const { kind, label } of kinds) {
    const group = rows.filter((row) => row.kind === kind);

    if (!group.length) {
      if (listedKinds.has(kind)) lines.push(`${label} —`);
      continue;
    }

    const gaps = group.map((row) => row.gap).filter(Number.isFinite);
    const excess = group.map((row) => row.gap - row.market_gap).filter(Number.isFinite);
    const beat = excess.filter((value) => value > 0).length;

    if (!listedKinds.has(kind)) {
      lines.push(`${label} ${group.length}건 · 갭 ${signed(average(gaps))}% · 초과 ${signed(average(excess))}%p · 상회 ${beat}/${excess.length}`);
      continue;
    }

    lines.push(`${label} ${group.length}건`);

    for (const row of group) {
      lines.push(`  ${row.name ?? row.symbol} ${row.symbol}  갭 ${signed(row.gap)}% (초과 ${signed(row.gap - row.market_gap)}%p) · 종가까지 ${signed(row.to_close)}%`);
      // 사람의 판단은 이유가 같이 있어야 맞았을 때와 틀렸을 때를 나중에 가를 수 있습니다.
      if ((kind === "user_close_bet" || kind === "offhigh_close_bet") && row.theme) lines.push(`  └ ${row.theme}`);
    }
  }

  return lines;
}

function enteredSection(rows) {
  if (!rows.length) return ["■ 어제 들어간 기록이 없습니다"];

  const day = rows[0].day;
  const lines = [`■ ${dayLabel(day)} 종가에 들어간 것 · 오늘 09:05~09:10 청산`];
  const others = [];

  for (const { kind, label } of kinds) {
    const group = rows.filter((row) => row.kind === kind);

    if (!listedKinds.has(kind)) {
      if (group.length) others.push(`${label} ${group.length}`);
      continue;
    }

    if (!group.length) {
      lines.push(kind === "user_close_bet"
        ? `${label} — (어제 산 게 있으면 node scripts/log-pick.mjs <종목> "<이유>" --date ${day})`
        : `${label} —`);
      continue;
    }

    lines.push(`${label} ${group.length}건`);

    for (const row of group) {
      lines.push(`  ${row.name ?? row.symbol} ${row.symbol}  ${signed(row.change_rate ?? row.entry_rate)}% · ${won(row.close)}`);
      if ((kind === "user_close_bet" || kind === "offhigh_close_bet") && row.theme) lines.push(`  └ ${row.theme}`);
    }
  }

  if (others.length) lines.push(`그 밖에 ${others.join(" · ")}`);

  return lines;
}

function cumulativeSection(cumulative) {
  const lines = ["■ 누적 (채점된 것만) · 초과 = 갭 − 시장 갭"];

  for (const { kind, label } of kinds) {
    const row = cumulative.get(kind);

    if (!row) continue;

    lines.push(`${label} ${row.n}건 · 상회 ${row.beat}/${row.n} · 초과 ${signed(row.excess, 2)}%p`);
  }

  lines.push("※ 20건 전엔 조건을 바꾸지 마세요. 한 건 빗나갔다고 고치면 과적합입니다.");

  return lines;
}
