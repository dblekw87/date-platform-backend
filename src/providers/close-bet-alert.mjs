import { loadCloseBetCandidates } from "./close-bet.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { sessionDate } from "./market-session.mjs";

/**
 * 종가에 사야 하는 것을 종가 전에 알립니다.
 *
 * 이 조건은 지금까지 화면에만 있었습니다. 그런데 **판단 시각이 하루에 한 번,
 * 몇 분짜리**라 화면을 그때 보고 있지 않으면 없는 것과 같습니다. 짝꿍은 장중에
 * 수십 번 잡히니 언제 봐도 남아 있지만, 종가배팅은 15:30을 놓치면 다음 날입니다.
 *
 * 15:20에 보냅니다. 조건은 장중 표본으로 계산한 잠정값이고 15:30 확정과 조금
 * 달라질 수 있지만, 확정된 뒤에 보내면 주문을 낼 시간이 없습니다. 10분은
 * 잠정값이 뒤집힐 여지와 주문을 낼 여유를 맞바꾼 값입니다.
 *
 * 청산은 익일 09:05~09:10입니다([[close-bet-findings]]). 알림에 같이 적는 것은
 * 그 시각을 아는 것이 조건의 일부이기 때문입니다 -- 들고 있으면 값이 달라집니다.
 */

const alertMinute = 15 * 60 + 20;
const stopMinute = 15 * 60 + 32;

let sentDay = null;
let running = false;

export function closeBetAlertDue(minute) {
  return minute >= alertMinute && minute < stopMinute && sentDay !== sessionDate("KR");
}

export async function notifyCloseBet(config, { minute, url } = {}) {
  if (running || !notifyConfigured(config)) return 0;
  if (!closeBetAlertDue(minute)) return 0;

  running = true;

  try {
    const day = sessionDate("KR");
    const candidates = await loadCloseBetCandidates(config, { limit: 10 });
    // 오늘 것만. 장이 열리기 전이면 확정 경로가 어제 목록을 돌려주는데, 화면에는
    // 그게 맞고 알림에는 아닙니다 -- 짝꿍이 2026-08-28에 겪은 자리와 같습니다.
    const today = candidates.filter((row) => row.sessionDate === day);

    /*
     * 조건을 넘은 것이 없으면 보내지 않습니다. "오늘은 없습니다"를 매일 보내면
     * 알림을 읽지 않게 되고, 정작 있는 날을 놓칩니다.
     *
     * **여기서 날을 잠그지 않습니다.** 잠그면 15:20에 아직 조건을 못 넘은 종목이
     * 15:25에 넘어도 알림이 안 갑니다 -- 조건은 장중 표본으로 계산하는 잠정값이라
     * 그 10분 사이에 바뀌는 것이 정상입니다. 창이 15:32에 닫히므로 잠그지 않아도
     * 시도는 열두 번을 넘지 않고, 없는 날은 그냥 아무것도 안 간 채 끝납니다.
     */
    if (!today.length) return 0;

    const ok = await notify(config, { text: closeBetMessage(today, day), url });

    if (!ok) return 0;

    sentDay = day;
    console.log(`알림: 종가배팅 · ${today.map((row) => row.name).join(", ")}`);

    return today.length;
  } catch (error) {
    console.warn("close bet alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

const won = (value) => Number(value ?? 0).toLocaleString("ko-KR");

/*
 * 성적은 종목이 아니라 등급에 붙는 값입니다. 종목마다 적으면 같은 문장이 후보
 * 수만큼 반복되고, 정작 종목마다 다른 숫자가 그 사이에 파묻힙니다. 화면이
 * groupByTier로 하는 일과 같습니다.
 */
export function closeBetMessage(candidates, day) {
  const lines = [`[종가배팅] ${day} · 후보 ${candidates.length}종목`, ""];
  const byTier = new Map();

  for (const row of candidates) {
    if (!byTier.has(row.tier)) byTier.set(row.tier, []);
    byTier.get(row.tier).push(row);
  }

  for (const [tier, rows] of byTier) {
    const measured = rows[0].measured;

    /* beatRate·gapUpRate는 비율(0.684)이고 excessMean은 이미 %p입니다. 화면이
     * 쓰는 것과 같은 변환을 씁니다 -- 알림과 보드가 다른 숫자를 말하면 어느 쪽이
     * 맞는지 확인하는 데 시간이 듭니다. */
    lines.push(measured
      ? `${tier} · 상회 ${Math.round(measured.beatRate * 100)}%`
        + ` · 갭상승 ${Math.round(measured.gapUpRate * 100)}%`
        + ` · 초과 ${measured.excessMean >= 0 ? "+" : ""}${measured.excessMean.toFixed(2)}%p`
        + ` · ${measured.nights}일`
      : tier);

    for (const row of rows) {
      lines.push(
        `  ${row.name} ${row.symbol} ${won(row.closePrice)}원`
        + ` (${row.changeRateValue > 0 ? "+" : ""}${row.changeRateValue}%)`
        + ` 회전 ${row.turnoverRatio}%`
      );

      for (const item of (row.evidence ?? []).slice(0, 1)) {
        if (!item.headline) continue;

        lines.push(`    ${item.headline.slice(0, 80)}`);

        if (item.url) lines.push(`    ${item.url}`);
      }
    }

    lines.push("");
  }

  lines.push("15:20 잠정값입니다. 청산은 익일 09:05~09:10.");

  return lines.join("\n");
}
