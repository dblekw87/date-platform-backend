import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { loadCloseBetCandidates } from "./close-bet.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";
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
/* 상한가로 보는 문턱. limit-up-queue.mjs와 같은 값입니다. */
const limitUpRate = 29.5;
const stopMinute = 15 * 60 + 32;

let running = false;

export function closeBetAlertDue(minute) {
  return minute >= alertMinute && minute < stopMinute;
}

export async function notifyCloseBet(config, { minute, url } = {}) {
  if (running || !notifyConfigured(config)) return 0;
  if (!closeBetAlertDue(minute)) return 0;

  running = true;

  try {
    const day = sessionDate("KR");

    // 하루 한 통. 기록이 저장소에 있어 15:25에 재기동해도 15:20 것을 또 보내지 않습니다.
    if ((await loadAlertSent(config, "close_bet", day)).has("sent")) return 0;

    const candidates = await loadCloseBetCandidates(config, { limit: 10 });
    // 오늘 것만. 장이 열리기 전이면 확정 경로가 어제 목록을 돌려주는데, 화면에는
    // 그게 맞고 알림에는 아닙니다 -- 짝꿍이 2026-08-28에 겪은 자리와 같습니다.
    //
    // 소형은 상한가만 보냅니다(2026-10-11 사용자 요청). 소형 종가배팅의 엣지는 처음부터
    // 상한가 칸에만 있었습니다 -- 258장 실측에서 상한가 아닌 소형 신호는 초과 중앙
    // +15~29.5% +0.10 / +15% 미만 −0.02로 0 근처였고, 최근 40일엔 −0.04 / −0.55입니다.
    // 기록은 close-bet-log.mjs가 따로 남기므로 채점 표본은 그대로 쌓입니다.
    const today = candidates.filter((row) => row.sessionDate === day
      && (row.tier !== "소형" || row.changeRateValue >= limitUpRate));

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

    const queues = await loadLockedQueues(config, day, today.filter((row) => row.changeRateValue >= limitUpRate).map((row) => row.symbol))
      .catch(() => new Map());
    const marked = today.map((row) => (row.changeRateValue >= limitUpRate ? { ...row, lock: queues.get(row.symbol) ?? { queue: null } } : row));
    const ok = await notify(config, { text: closeBetMessage(marked, day), url });

    if (!ok) return 0;

    await markAlertSent(config, "close_bet", day, "sent", { note: today.map((row) => row.name).join(", ").slice(0, 200) });
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
 * 상한가에 잠긴 종목의 매수 잔량 -- 그 줄 뒤에 서는 것이라 종가에 체결되기 어렵습니다.
 *
 * 2026-10-11 실측(09-15~ 상한가 종가배팅 24건): 15:19에 23건이 잠겨 있었고, 15:20
 * 이후 마감 체결량은 줄 선 매수잔량의 **중앙 6%**였습니다. 새 매수가 체결될 만큼
 * 마감 물량이 나온 4건은 다음날 초과 중앙 **−0.68%p·상회 25%**, 못 사는 14건은
 * +3.45·79%였습니다 -- 체결되는 날이 상한가가 무너지는 날입니다([[sangtta-verdict]]).
 * 그래서 "사라"는 목록 안에서 이 줄만은 "사기 어렵고, 사지면 조심"이라고 적습니다.
 *
 * 매도1호가 잔량이 없으면 잠긴 것으로 봅니다. 호가는 24% 위 종목만 1분마다 찍히므로
 * 상한가 후보에는 거의 늘 있습니다. 없으면 잔량 없이 표시만 합니다.
 */
async function loadLockedQueues(config, day, symbols) {
  if (!symbols.length) return new Map();

  const { rows } = await query(config, `
    SELECT DISTINCT ON (symbol) symbol, bid_qty1::float8 AS queue, ask_qty1::float8 AS ask
      FROM kr_order_book_samples
     WHERE session_date = $1::date AND symbol = ANY($2)
     ORDER BY symbol, observed_at DESC`, [day, symbols]);

  return new Map(rows.map((row) => [row.symbol, { locked: !(row.ask > 0), queue: row.queue }]));
}

/*
 * 성적은 종목이 아니라 등급에 붙는 값입니다. 종목마다 적으면 같은 문장이 후보
 * 수만큼 반복되고, 정작 종목마다 다른 숫자가 그 사이에 파묻힙니다. 화면이
 * groupByTier로 하는 일과 같습니다.
 */
export function closeBetMessage(candidates, day) {
  const lines = [`[종가배팅] ${day} · 후보 ${candidates.length}종목 · 오늘 종가에 사는 것`, ""];
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

      if (row.lock && row.lock.locked !== false) {
        const queue = row.lock.queue > 0 ? ` · 매수잔량 ${won(Math.round(row.lock.queue))}주` : "";

        lines.push(`    └ 상한가 잠김 · 종가 체결 어려움${queue}. 체결되면 무너지는 날 (실측 4건 중앙 −0.68%p)`);
      }

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
