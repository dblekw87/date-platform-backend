import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { seoulMinuteNow } from "./market-session.mjs";

/**
 * 장중 알림을 한 통으로 묶습니다.
 *
 * 사용자가 장중매매를 접었습니다 -- "회사를 다니다보니 장중매매는 좀 힘들것 같아
 * 눈치보면서 호가창도 제대로 못보고 차트도 못보니"(2026-10-02). 그러면 장중에 오는
 * 알림은 보고도 할 수 있는 것이 없습니다. 그런데 알림의 **76%가 장중**입니다
 * (2026-09-15 이후 `alert_sent`: 장중 1,397건 대 쓸 수 있는 구간 445건).
 *
 *   featured        하루 52.1통  장중 678
 *   limit_pair      하루 38.8통  장중 459
 *   sangtta_watch   하루 14.6통  장중 173   <- 남깁니다
 *   limit_up        하루  6.5통  장중  76   <- 남깁니다
 *
 * 상따와 상한가는 **그대로 둡니다.** 상따는 장중에 잠기고, 사용자가 실제로 하는
 * 매매입니다. 묶는 것은 featured와 limit_pair 둘뿐입니다.
 *
 *   featured    [[leader-trade-verdict]] 하룻밤 +0.38%p뿐, D+2부터 마이너스.
 *               상승률 상위 +5.6%p는 상한가라 못 사는 자리
 *   limit_pair  [[pair-intraday-verdict]] 149건 실측, 장중 구간은 대조군과
 *               구별 안 됨. 등급은 종가매수 전용
 *
 * **기록은 그대로 남깁니다.** 발송만 막고 `alert_sent`에는 적습니다. 알림이 표본을
 * 만들기 때문입니다 -- 끊으면 `kr_signal_outcomes`가 안 쌓여 다음에 다시 잴 것이
 * 없어집니다([[sangtta-verdict]]에서 호가 수집 문턱을 일부러 24%에 남겨 둔 것과
 * 같은 이유). 그리고 묶은 것은 15:20 창에 한 통으로 보냅니다 -- 안 보내는 것과
 * 눈에서 지우는 것은 다릅니다.
 *
 * 결과: 하루 ~91통이 ~15통으로 줄고, 장중에 오던 것은 15:20에 한 통으로 옵니다.
 * 15:20은 종가배팅 알림이 오는 창이라 사용자가 이미 보는 시각입니다.
 */

/** 묶인 줄임을 note 앞에 적습니다. 요약이 이것으로 골라냅니다. */
export const heldMark = "held:";

/* 국내 정규장. 프리마켓(08:00~08:50)은 출근 직후라 사용자가 보는 시각이므로 뺍니다. */
const heldFromMinute = 8 * 60 + 50;
/* 15:20 창 직전까지. 그 뒤는 사용자가 보는 시각이라 그대로 보냅니다. */
const heldToMinute = 15 * 60 + 15;
/* 요약을 보내는 창. 종가배팅·미돌파와 같은 창입니다(provider가 하루 한 번을 잠굽니다). */
const digestFromMinute = 15 * 60 + 20;
const digestToMinute = 15 * 60 + 32;

/** 지금 보낸 것이 사용자에게 쓸모가 없는 시각인가. */
export function heldWindow(now = new Date()) {
  const minute = seoulMinuteNow(now);

  return minute >= heldFromMinute && minute < heldToMinute;
}

/** 요약을 보낼 창인가. */
export function digestWindow(minute) {
  return minute >= digestFromMinute && minute < digestToMinute;
}

const digests = [
  { kind: "featured", label: "특징주" },
  { kind: "limit_pair", label: "짝꿍" }
];

/**
 * 장중에 묶어 둔 것을 한 통으로. 하루 한 번입니다.
 *
 * 묶인 것이 없으면 아무것도 보내지 않습니다 -- "오늘은 0건"을 보내는 것은 통 수를
 * 줄이자고 시작한 일에 통을 하나 더하는 셈입니다.
 */
export async function notifyIntradayDigest(config, { day, minute, url } = {}) {
  if (!notifyConfigured(config) || !digestWindow(minute)) return 0;
  if ((await loadAlertSent(config, "intraday_digest", day)).has("done")) return 0;

  const digest = await buildIntradayDigest(config, day);

  if (!digest) return 0;
  if (!await notify(config, { text: digest.text, url })) return 0;

  await markAlertSent(config, "intraday_digest", day, "done", { note: `${digest.total}건` });
  console.log(`알림: 장중 요약 ${digest.total}건`);

  return digest.total;
}

/**
 * 본문만. 보낼 것이 없으면 null입니다.
 *
 * notify와 갈라 둔 것은 **보내지 않고 확인하려고**입니다. notify 모듈에는 드라이런이
 * 없어서(부르면 진짜 나갑니다) 합친 채로는 사람이 본문을 볼 방법이 없습니다.
 * buildWeekendBrief / notifyWeekendBrief와 같은 모양입니다.
 */
export async function buildIntradayDigest(config, day) {
  const sections = [];

  for (const { kind, label } of digests) {
    /*
     * 시각 순으로 읽히게 정렬합니다. loadAlertSent는 키로 만든 Map을 돌려주므로
     * 그대로 쓰면 09:11, 09:10, 09:11처럼 뒤섞입니다. note가 `held:HH:MM ...`
     * 모양이라 문자열 비교로 시각 순이 됩니다(짝꿍은 시각이 없어 이름 순).
     */
    const rows = [...(await loadAlertSent(config, kind, day)).values()]
      .filter((row) => String(row.note ?? "").startsWith(heldMark))
      .sort((a, b) => String(a.note).localeCompare(String(b.note), "ko"));

    if (!rows.length) continue;

    sections.push({ label, rows });
  }

  if (!sections.length) return null;

  const total = sections.reduce((sum, section) => sum + section.rows.length, 0);
  const lines = [`[장중 요약] 보고 있지 않은 시각에 ${total}건 · 사는 자리가 아닙니다`, ""];

  for (const { label, rows } of sections) {
    lines.push(`■ ${label} ${rows.length}건`);

    /* 열 건까지만. 그보다 많으면 읽지 않고, 세는 것은 위 숫자가 합니다. */
    for (const row of rows.slice(0, 10)) lines.push(`  ${String(row.note ?? "").slice(heldMark.length)}`);

    if (rows.length > 10) lines.push(`  … 외 ${rows.length - 10}건`);

    lines.push("");
  }

  lines.push("장중 구간은 실측에서 대조군과 구별되지 않습니다(짝꿍 149건).");
  lines.push("주도주도 하룻밤 +0.38%p뿐이고 D+2부터 마이너스입니다.");

  return { text: lines.join("\n"), total };
}
