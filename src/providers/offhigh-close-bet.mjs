import { closeBetCandidateSql, historyBoundFor, liveCandidateSql, loadEntryNews } from "./close-bet.mjs";
import { isReasonHeadline } from "./overnight-classify.mjs";
import { closeBetSlotAt, loadMaterial } from "./close-bet-alert.mjs";
import { isEtfLike, isNonOperatingEquity } from "./themes.mjs";
import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";
import { sessionDate } from "./market-session.mjs";

/**
 * 종가배팅 조건을 다 맞췄는데 **60일 신고점만 아닌** 종목.
 *
 * 사용자가 2026-09-11에 짚었습니다 -- 전날 에스투더블유(488280)가 오픈AI
 * '데이브레이크' 합류로 +11.9%, 거래대금 102억, 고가 마감이었는데 종가배팅 후보에
 * 없었습니다. 조건 다섯 개 중 넷을 통과하고 "종가 > 60일 신고점" 하나에서
 * 떨어졌습니다 -- 6월 고점 16,270원에서 -28% 자리였으니까요. "이런 것들이 잡혀야
 * 내가 종가배팅을 하지"가 이 파일이 있는 이유입니다.
 *
 * **먼저 쟀습니다.** 2025-01~2026-09, 412세션:
 *
 *   돌파(현재 규칙)  2,140건  초과 +3.25%p  상회 62%
 *   미돌파           2,111건  초과 +1.37%p  상회 53%   ← 이 파일
 *   돌파(연속)         885건  초과 +0.30%p  상회 60%
 *
 * 미돌파도 0이 아닙니다. 현재 규칙의 40%쯤이고, 하루 5.8건이라 목록으로 볼 만한
 * 양입니다. 그래서 **섞지 않고 따로** 냅니다 -- 한 목록에 합치면 1,524건짜리
 * 종가배팅 측정이 희석되고, 두 규칙 중 어느 쪽이 값을 냈는지 영영 못 가립니다.
 *
 * **알림은 재료가 있는 것만.** 사용자가 산 두 건(현대힘스·에스투더블유)이 둘 다
 * 재료를 보고 산 것이고, 하루 5.8건을 통째로 보내면 읽지 않게 됩니다. 다만
 * **기록은 전부 남깁니다** -- 재료 있는 쪽과 없는 쪽을 같은 표에서 채점해야
 * "재료가 정말 값을 더하는가"를 물을 수 있습니다. 뉴스가 쌓인 20세션으로 먼저
 * 재보면 재료 있는 쪽이 상회 70%(37건) 대 51%(90건)로 앞서는데, 초과는 오히려
 * 낮습니다(+0.86 대 +1.53). 표본이 작아 아직 아무 말도 못 합니다.
 *
 * 채점은 `nightly-review.mjs`가 다음 거래일 봉으로 자동으로 합니다.
 */

/*
 * **종가배팅과 같은 칸·같은 거름망입니다**(2026-10-12). 그날 15:20 이 알림이 소형 상한가
 * 서산·금호전기를 "오전 이슈 : 서산, 금호전기, …" 기사를 재료로 보냈습니다 -- 종가배팅에서
 * 막 뺀 바로 그 자리(29.5%면 들어갈 수가 없다)였고, 재료는 나열 기사였습니다. 그래서:
 *
 *   시각   15:10 · 15:15(바뀌었을 때만) · 15:20(최종). close-bet-alert.mjs의 closeBetSlotAt
 *   소형   보내지 않습니다. 종가배팅과 같은 사용자 결정입니다
 *   재료   close-bet-alert.mjs의 loadMaterial -- 직전 장 마감 뒤 good 공시 또는 이유 기사,
 *          악재·기계기사·나열 기사 제외
 *
 * **기록은 15:20 칸에서 한 번만** 남깁니다(kr_signal_outcomes, 재료 유무 무관). 15:10에
 * 기록하면 412세션 실측과 다른 모집단이 됩니다. 기록의 theme은 예전처럼 isReasonHeadline
 * 기사 제목이라 이전 표본과 이어집니다.
 *
 * 2026-08-18~10-08 실측(scripts/measure-close-bet-material.mjs): 중·대형 재료 있음 8건
 * 중앙 +2.20·상회 88%, 재료 없음 6건 +0.30. 표본이 작습니다.
 */
// 한 통에 들어갈 만큼만. 재료가 있는 것만 보내므로 대개 두세 종목입니다.
const alertLimit = 8;

let running = false;

export async function notifyOffHighCloseBet(config, { minute, url } = {}) {
  if (running || !notifyConfigured(config)) return 0;

  const slot = closeBetSlotAt(minute);

  if (!slot) return 0;

  const day = sessionDate("KR");

  running = true;

  try {
    // 칸마다 한 번. "done"은 10-12 이전의 하루 한 통 기록입니다.
    const sent = await loadAlertSent(config, "offhigh_close_bet", day);

    if (sent.has("done") || sent.has(slot.key)) return 0;

    const candidates = await loadOffHighCandidates(config, { day });
    const final = slot.key === "slot:1520";
    const saved = final ? await recordOffHighCloseBet(config, day, candidates) : 0;
    const pool = candidates.filter((row) => row.size_label && row.size_label !== "소형");
    const material = await loadMaterial(config, day, pool.map((row) => row.symbol));
    const picked = pool
      .filter((row) => material.has(row.symbol))
      .slice(0, alertLimit)
      .map((row) => ({ ...row, alertMaterial: material.get(row.symbol), fresh: !sent.has(row.symbol) }));
    const dropped = [...sent.keys()]
      .filter((key) => !key.startsWith("slot:") && !picked.some((row) => row.symbol === key))
      .map((symbol) => sent.get(symbol)?.note ?? symbol);
    const changed = dropped.length > 0 || picked.some((row) => row.fresh);

    if ((!picked.length && !dropped.length) || (slot.onlyIfChanged && !changed)) {
      if (final) console.log(`미돌파 종가배팅 · 기록 ${saved}건, 알림 없음(재료 있는 중·대형 없음)`);

      return 0;
    }

    if (!await notify(config, { text: message(picked, day, { dropped, slot: slot.label, total: candidates.length }), url })) return 0;

    for (const row of picked) await markAlertSent(config, "offhigh_close_bet", day, row.symbol, { note: row.name ?? row.symbol });
    await markAlertSent(config, "offhigh_close_bet", day, slot.key, { note: picked.map((row) => row.name ?? row.symbol).join(", ").slice(0, 200) || "전부 빠짐" });
    console.log(`알림: 미돌파 종가배팅 ${slot.label} · ${picked.map((row) => row.name ?? row.symbol).join(", ") || "-"}${final ? ` (기록 ${saved})` : ""}`);

    return picked.length;
  } catch (error) {
    console.warn("offhigh close bet alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

/**
 * 오늘의 미돌파 후보. 일봉이 들어와 있으면 그것으로, 아직이면 장중 표본으로.
 *
 * 종가배팅과 같은 갈림길을 씁니다 -- 15:20에 부르면 오늘 일봉은 아직 없고
 * (수집이 15:50), 저녁에 부르면 있습니다. 같은 조건을 두 경로로 계산하는 것은
 * `close-bet.mjs`가 이미 하는 일이라, 그 조립을 `breakout: false`로 다시 씁니다.
 */
export async function loadOffHighCandidates(config, { day = sessionDate("KR"), limit = 20, until = null } = {}) {
  if (!config.databaseUrl) return [];

  const barDay = (await query(config, "SELECT max(session_date)::text AS day FROM kr_daily_bars")).rows[0]?.day ?? null;
  const provisional = !barDay || day > barDay;
  const result = provisional
    ? await query(config, liveCandidateSql({ breakout: false }), [day, limit])
    : await query(config, `
      WITH candidates AS (${closeBetCandidateSql({ breakout: false, day, since: historyBoundFor(day) })})
      SELECT c.*, c.session_date::text AS session_day, u.name, u.market, u.market_cap, u.trade_halted
        FROM candidates c
        LEFT JOIN kr_daily_universe u ON u.symbol = c.symbol AND u.session_date = c.session_date
       WHERE c.session_date = $1::date
       ORDER BY c.turnover DESC
       LIMIT $2
    `, [day, limit]);
  /*
   * 거래정지된 종목은 살 수 없습니다. 장중 경로는 이 값을 안 들고 오므로 없으면
   * 통과입니다 -- 정지되면 애초에 표본이 안 들어옵니다.
   *
   * ETF도 뺍니다. 돌파 조건이 없으면 레버리지 ETF가 곧바로 올라옵니다 --
   * 2026-09-09 열 종목 중 넷이 KODEX·TIGER였습니다. 이 매매는 재료를 보고 사는
   * 것이고 지수 상품에는 재료가 없습니다. 우선주·스팩도 같은 이유로 뺍니다.
   */
  const tradable = result.rows.filter((row) => !row.trade_halted
    && !isEtfLike(row.name ?? "") && !isNonOperatingEquity(row.name ?? ""));
  const rows = tradable.map((row) => ({ ...row, session_day: row.session_day ?? day }));
  // 재료는 **진입 시점까지** 나온 기사만. 여덟 건까지 받아 그중 재료를 고릅니다.
  const news = await loadEntryNews(config, rows, {
    perSymbol: 8,
    until: until ?? (provisional ? nowHhmm() : "15:30")
  });

  return rows.map((row) => ({
    ...row,
    material: materialOf(news.get(row.symbol) ?? []),
    provisional
  }));
}

/*
 * 재료인 기사 하나. 복기는 재료가 아닙니다.
 *
 * "우리로 주가, 상한가... 왜?"나 "SFA반도체 주가, 장중 7.39% 상승"은 오른 것을
 * 다시 쓴 글입니다. 그걸 재료로 세면 "올랐으니 재료가 있다"는 동어반복이 되고,
 * 복기 기사는 10세션 실측에서 승률 40%로 반증됐습니다([[overnight-material-verdict]]).
 *
 * 판정은 `overnight-classify.mjs`가 합니다 -- 상한가 알림이 쓰던 그 규칙 그대로입니다.
 */
function materialOf(headlines) {
  return headlines.find((item) => isReasonHeadline(item.headline)) ?? null;
}

/** 전부 남깁니다 -- 알림은 재료 있는 것만 가도, 채점은 둘 다 되어야 비교가 됩니다. */
export async function recordOffHighCloseBet(config, day, rows) {
  if (rows.length === 0) return 0;

  const result = await query(config, `
    INSERT INTO kr_signal_outcomes
      (kind, session_date, symbol, detected_at, tier, theme, entry_rate)
    SELECT 'offhigh_close_bet', $1::date, symbol,
           ($1::date + interval '15 hours 20 minutes') AT TIME ZONE 'Asia/Seoul',
           tier, theme, rate
      FROM unnest($2::text[], $3::text[], $4::text[], $5::numeric[])
        AS t(symbol, tier, theme, rate)
    ON CONFLICT (kind, session_date, symbol) DO NOTHING
  `, [
    day,
    rows.map((row) => row.symbol),
    rows.map((row) => row.size_label ?? null),
    // 재료 제목을 그대로 둡니다. 나중에 "어떤 재료가 값을 냈나"를 물을 때
    // 낱말로 묶을 수 있고, 없으면 null이라 재료 없는 쪽과 바로 갈립니다.
    rows.map((row) => (row.material ? String(row.material.headline).slice(0, 200) : null)),
    rows.map((row) => (Number.isFinite(Number(row.day_move)) ? Number(row.day_move) : null))
  ]);

  return result.rowCount ?? 0;
}

const won = (value) => (Number.isFinite(Number(value)) ? `${Math.round(Number(value)).toLocaleString("ko-KR")}원` : "—");
const eok = (value) => (Number.isFinite(Number(value)) ? `${Math.round(Number(value) / 1e8).toLocaleString("ko-KR")}억` : "—");
const percent = (value) => (Number.isFinite(Number(value)) ? `${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(1)}%` : "—");

function message(rows, day, { dropped = [], slot = "15:10", total = rows.length } = {}) {
  const lines = [
    `[종가배팅·재료 ${slot}] ${day} · 신고점은 아니지만 재료로 오른 중·대형 ${rows.length}종목`,
    ""
  ];

  for (const row of rows) {
    lines.push(`${row.fresh && slot !== "15:10" ? "새 " : ""}${row.name ?? row.symbol} ${row.symbol} ${percent(row.day_move)} · ${won(row.close)} · 거래대금 ${eok(row.turnover)} · ${row.size_label ?? "?"}`);
    lines.push(`  60일 고점까지 ${percent(row.break_margin)} · 회전율 ${percent(row.turnover_ratio)}`);
    lines.push(`  재료 ${row.alertMaterial.kind} ${row.alertMaterial.at} ${String(row.alertMaterial.text).slice(0, 70)}`);

    if (row.alertMaterial.url) lines.push(`  ${row.alertMaterial.url}`);

    lines.push("");
  }

  if (dropped.length) {
    lines.push(`빠짐: ${dropped.join(", ")} — 앞 통에 있었는데 지금은 조건이나 재료를 못 넘습니다`);
    lines.push("");
  }

  lines.push(`※ 오늘 미돌파 후보 ${total}종목 중 재료 있는 중·대형만 보냅니다(소형 제외). 기록은 전부 남습니다.`);
  lines.push("※ 미돌파는 412세션 실측 초과 +1.37%p·상회 53%로, 돌파(+3.25%p·62%)보다 약합니다. 같은 자리로 보지 마세요.");

  return lines.join("\n");
}

/** 장중이면 지금까지의 기사만 근거입니다. 15:20 창에서 부르므로 대개 15:2x입니다. */
function nowHhmm() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", hour12: false, minute: "2-digit", timeZone: "Asia/Seoul"
  }).formatToParts(new Date());

  return `${parts.find((part) => part.type === "hour").value}:${parts.find((part) => part.type === "minute").value}`;
}
