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
 * **15:10에 보냅니다**(2026-10-12 사용자 요청: "15시 30분 전에, 되도록이면 15시 20분
 * 전에"). 15:20부터는 종가 단일가라 그 전에 받아야 주문을 생각할 여유가 있습니다.
 * 조건은 장중 표본으로 계산한 잠정값이고 15:30 확정과 조금 달라질 수 있습니다 --
 * 20분 앞당긴 만큼 더 달라질 수 있어서, 첫 통 뒤에 새로 조건을 넘은 종목은 15:25까지
 * 한 번씩 [추가]로 보냅니다. 종목마다 한 번이라 같은 이름이 두 번 가지는 않습니다.
 *
 * 청산은 익일 09:05~09:10입니다([[close-bet-findings]]). 알림에 같이 적는 것은
 * 그 시각을 아는 것이 조건의 일부이기 때문입니다 -- 들고 있으면 값이 달라집니다.
 */

const alertMinute = 15 * 60 + 10;
/* 상한가로 보는 문턱. limit-up-queue.mjs와 같은 값입니다. */
const limitUpRate = 29.5;
/* 종가 단일가(15:20~15:30) 안에서도 주문은 낼 수 있어 추가분은 15:25까지 받습니다. */
const stopMinute = 15 * 60 + 25;

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

    // 종목마다 한 번. 기록이 저장소에 있어 창 안에서 재기동해도 같은 종목을 또 보내지 않습니다.
    // "sent"는 10-12 이전의 하루 한 통 기록입니다 -- 그 키가 있는 날은 이미 끝난 날입니다.
    const sent = await loadAlertSent(config, "close_bet", day);

    if (sent.has("sent")) return 0;

    // 소형을 빼고 열 개를 채우려고 넉넉히 받습니다 -- 소형이 위를 다 차지하는 날
    // limit 10으로 받으면 중·대형이 잘려 나갑니다.
    const candidates = await loadCloseBetCandidates(config, { limit: 40 });
    // 오늘 것만. 장이 열리기 전이면 확정 경로가 어제 목록을 돌려주는데, 화면에는
    // 그게 맞고 알림에는 아닙니다 -- 짝꿍이 2026-08-28에 겪은 자리와 같습니다.
    //
    // **소형은 보내지 않습니다**(2026-10-12 사용자 결정). 소형 종가배팅에는 살 수 있는
    // 칸에 엣지가 없습니다(258장 실측, 초과 중앙):
    //   상한가 아님        +0.10 / −0.02, 최근 40일 −0.04 / −0.55   살 수 있음
    //   상한가·잠김 유지   +3.45                                    못 삼(마감 체결량 = 매수잔량의 6%)
    //   상한가·체결됨      −0.68                                    살 수 있지만 무너지는 날
    // 하루 전엔 상한가만 남겼는데, 사용자가 "29.5%면 들어갈 수가 없다"고 짚었습니다 --
    // 그러면 이 알림은 못 사는 종목 목록일 뿐입니다. 소형에서 들어갈 자리는 잠기기 전이고
    // 그건 [상한가 직전](sangtta-watch.mjs)이 맡습니다. 기록은 nightly-review.mjs가
    // 후보 전부를 따로 남기므로 채점 표본은 그대로 쌓입니다.
    const today = candidates
      .filter((row) => row.sessionDate === day && row.tier !== "소형")
      .slice(0, 10)
      .filter((row) => !sent.has(row.symbol));

    /*
     * 조건을 넘은 것이 없으면 보내지 않습니다. "오늘은 없습니다"를 매일 보내면
     * 알림을 읽지 않게 되고, 정작 있는 날을 놓칩니다.
     *
     * **날을 잠그지 않고 종목을 잠급니다.** 날을 잠그면 15:10에 아직 조건을 못 넘은
     * 종목이 15:15에 넘어도 알림이 안 갑니다 -- 조건은 장중 표본으로 계산하는 잠정값이라
     * 그 사이에 바뀌는 것이 정상입니다. 창이 15:25에 닫히므로 시도는 열다섯 번을 넘지
     * 않고, 없는 날은 그냥 아무것도 안 간 채 끝납니다.
     */
    if (!today.length) return 0;

    const queues = await loadLockedQueues(config, day, today.filter((row) => row.changeRateValue >= limitUpRate).map((row) => row.symbol))
      .catch(() => new Map());
    const marked = today.map((row) => (row.changeRateValue >= limitUpRate ? { ...row, lock: queues.get(row.symbol) ?? { queue: null } } : row));
    const followUp = sent.size > 0;
    const ok = await notify(config, { text: closeBetMessage(marked, day, { followUp }), url });

    if (!ok) return 0;

    for (const row of today) await markAlertSent(config, "close_bet", day, row.symbol, { note: row.name });
    console.log(`알림: 종가배팅${followUp ? " 추가" : ""} · ${today.map((row) => row.name).join(", ")}`);

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
export function closeBetMessage(candidates, day, { followUp = false } = {}) {
  const lines = [followUp
    ? `[종가배팅 추가] ${day} · 첫 통 뒤 새로 조건을 넘은 ${candidates.length}종목`
    : `[종가배팅] ${day} · 후보 ${candidates.length}종목 · 오늘 종가에 사는 것`, ""];
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

  lines.push("장중 잠정값입니다(15:30 종가에 확정). 청산은 익일 09:05~09:10.");

  return lines.join("\n");
}
