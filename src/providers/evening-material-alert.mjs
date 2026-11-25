import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";
import { sessionDate } from "./market-session.mjs";

/**
 * 17:10 저녁 점검: 오늘 마감 뒤 재료로 이미 알린 종목이 애프터마켓에서 어떻게 움직이고 있나.
 *
 * 재료 알림(material-alert.mjs)은 잡힌 순간 한 번 갑니다. 2026-11-24 다올투자증권은 15:10
 * "[단독] M&A 매물로" 기사 → 16:31 "[다음 장 후보]" B등급으로 혼자 나갔는데, 그때 애프터는
 * +3%였고 17:04에 +17%, 17:59에 +20.6%까지 갔습니다. 다음날 장중 +27%. 알림을 받은 순간엔
 * 아직 움직이지 않은 재료였고, 그 뒤에 돈이 붙은 걸 다시 알려 주는 것이 없었습니다
 * (사용자 11/25 "다올은 좀 아깝다" → "응 알림 해줘").
 *
 * 그래서 한 통으로 다시 모읍니다: 종가, 지금 애프터(종가 대비), 애프터 거래대금, 시총.
 * 재료 기록 없이 애프터에서 크게 뛴 종목도 밑에 몇 개 붙입니다 -- 기사를 우리가 못 붙인
 * 경우가 그 자리에 보입니다.
 *
 * **사라는 알림이 아닙니다.** 측정으로는 애프터가 종가보다 +1~5% 위면 다음날 시가가 중앙
 * −0.49(57건, memory krx-after-market), +5% 위 추격은 본전 이하였습니다. 갭을 저녁에 이미
 * 가져간 자리라 그 숫자를 알림 끝에 같이 적습니다. 아직 안 움직인 재료 쪽은 재 본 적이 없습니다.
 */

const kind = "evening_material";
const startMinute = 17 * 60 + 10;
const stopMinute = 17 * 60 + 25;
const listLimit = 10;
/* 재료 기록 없이 뛴 종목: 종가 대비 이만큼 위, 애프터 거래대금 이만큼 이상. */
const unexplainedRate = 8;
const unexplainedTurnover = 500_000_000;

let running = false;

export function eveningMaterialDue(minute) {
  return minute >= startMinute && minute < stopMinute;
}

export async function notifyEveningMaterial(config, { minute, url } = {}) {
  if (running || !notifyConfigured(config) || !eveningMaterialDue(minute)) return 0;

  running = true;

  try {
    const day = sessionDate("KR");
    const sent = await loadAlertSent(config, kind, day);

    if (sent.has("slot:1710")) return 0;

    const { picks, unexplained } = await loadEveningMoves(config, day);

    // 없는 날은 보내지 않습니다. 칸도 잠그지 않아 창 안에서 생기면 그때 갑니다.
    if (!picks.length && !unexplained.length) return 0;

    const ok = await notify(config, { text: eveningMaterialMessage(day, picks, unexplained), url });

    if (!ok) return 0;

    await markAlertSent(config, kind, day, "slot:1710", { note: picks.map((row) => row.name).join(", ").slice(0, 200) || "재료 없음" });
    console.log(`알림: 저녁 재료 점검 · ${picks.map((row) => row.name).join(", ") || "-"}`);

    return picks.length;
  } catch (error) {
    console.warn("evening material alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

/* 애프터 등락은 KIS 값 그대로 전일 종가 기준이라, 정규장 등락으로 나눠 종가 대비로 바꿉니다. */
function versusClose(afterRate, closeRate) {
  if (afterRate == null) return null;

  return ((1 + afterRate / 100) / (1 + (closeRate ?? 0) / 100) - 1) * 100;
}

export async function loadEveningMoves(config, day, { freshMinutes = 40 } = {}) {
  const { rows } = await query(config, `
    WITH after AS (
      SELECT DISTINCT ON (symbol) symbol, source, change_rate::float8 AS after_rate, turnover::float8 AS after_turnover,
             to_char(observed_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS after_at
        FROM market_price_samples
       WHERE market = 'KR' AND session_date = $1::date AND source IN ('kis:after:krx', 'kis:nxt:after')
         AND observed_at >= now() - ($2 || ' minutes')::interval
       ORDER BY symbol, turnover DESC NULLS LAST, observed_at DESC),
    picks AS (
      SELECT symbol, min(tier) AS tier, min(theme) AS evidence,
             to_char(min(detected_at) AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS detected_at
        FROM kr_signal_outcomes
       WHERE kind = 'overnight_material' AND session_date = $1::date
       GROUP BY symbol)
    SELECT coalesce(p.symbol, a.symbol) AS symbol, u.name, u.change_rate::float8 AS close_rate,
           u.market_cap::float8 AS market_cap, p.tier, p.evidence, p.detected_at,
           a.after_rate, a.after_turnover, a.after_at
      FROM picks p
      FULL JOIN after a ON a.symbol = p.symbol
      LEFT JOIN kr_daily_universe u ON u.symbol = coalesce(p.symbol, a.symbol) AND u.session_date = $1::date`, [day, String(freshMinutes)]);
  const withMove = rows.map((row) => ({ ...row, name: row.name ?? row.symbol, vsClose: versusClose(row.after_rate, row.close_rate) }));
  const byMove = (a, b) => (b.vsClose ?? -Infinity) - (a.vsClose ?? -Infinity);
  const picks = withMove.filter((row) => row.tier).sort(byMove).slice(0, listLimit);
  const unexplained = withMove
    .filter((row) => !row.tier && row.vsClose != null && row.vsClose >= unexplainedRate && (row.after_turnover ?? 0) >= unexplainedTurnover)
    .sort(byMove)
    .slice(0, 5);

  return { picks, unexplained };
}

const signed = (value, digits = 1) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
const eok = (value) => `${Math.round((value ?? 0) / 1e8).toLocaleString("ko-KR")}억`;

function moveLine(row) {
  if (row.after_rate == null) return "애프터 표본 없음";

  return `애프터 ${row.after_at} ${signed(row.after_rate)}%(종가 대비 ${signed(row.vsClose)}%) 거래 ${eok(row.after_turnover)}`;
}

export function eveningMaterialMessage(day, picks, unexplained = []) {
  const lines = [`[저녁 재료 점검 17:10] ${day} · 마감 뒤 재료 ${picks.length}종목이 애프터에서 어떻게 가나`, ""];

  for (const row of picks) {
    const close = row.close_rate == null ? "" : ` · 종가 ${signed(row.close_rate)}%`;
    const cap = row.market_cap ? ` · 시총 ${eok(row.market_cap)}` : "";

    lines.push(`[${row.tier}] ${row.name} ${row.symbol}${cap}${close}`);
    lines.push(`    ${moveLine(row)} · 재료 ${row.detected_at}`);
    if (row.evidence) lines.push(`    ${String(row.evidence).slice(0, 70)}`);
  }

  if (unexplained.length) {
    lines.push("", "재료 기록 없이 애프터에서 뛴 종목(기사를 못 붙였을 수 있음):");
    for (const row of unexplained) lines.push(`  ${row.name} ${row.symbol} · ${moveLine(row)}`);
  }

  lines.push(
    "",
    "사라는 알림이 아닙니다. 실측: 애프터가 종가보다 +1~5% 위면 다음날 시가 중앙 −0.49(57건), +5% 위 추격은 본전 이하 — 갭을 저녁에 이미 가져간 자리입니다."
  );

  return lines.join("\n");
}
