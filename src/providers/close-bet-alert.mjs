import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { classifyDisclosure, isMachineHeadline, isReasonHeadline, mentionsBadNews } from "./overnight-classify.mjs";
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
 * **15:10 · 15:15 · 15:20 세 번입니다**(2026-10-12 사용자 요청: "15시 10분 15분 이렇게
 * 보내줘도 되고", "20분에도 보내줘 종가에 살 수도 있으니"). 15:20부터는 종가 단일가라
 * 그 전에 받아야 주문을 생각할 여유가 있고, 15:20 통은 단일가에 넣을 사람을 위한
 * 마지막 목록입니다. 조건은 장중 표본으로 계산한 잠정값이라 15:30 확정과 달라질 수
 * 있습니다 -- 그래서 통마다 지금 목록 전체를 보내고 새로 들어온 것과 빠진 것을 적습니다.
 * 15:15는 목록이 바뀌었을 때만, 15:20은 목록이 있으면 늘 보냅니다.
 *
 * **재료가 있는 종목만 보냅니다**(같은 날 사용자: "재료 꼭 있어야 한다 공시든 뉴스든").
 * 재료는 직전 장 마감(15:30) 뒤부터 지금까지 나온 것입니다:
 *   공시  classifyDisclosure가 "good"으로 보는 것. [기재정정]은 원본의 1/9 값이라 뺍니다
 *   기사  isReasonHeadline -- 복기("~에 상한가")는 재료가 아닙니다. 악재·기계기사도 뺍니다
 * 사용자 매매 기록에서 재료 있음 +5.9만 / 없음 −31.3만이었습니다([[user-close-bet-log]]).
 *
 * 청산은 익일 09:05~09:10입니다([[close-bet-findings]]). 알림에 같이 적는 것은
 * 그 시각을 아는 것이 조건의 일부이기 때문입니다 -- 들고 있으면 값이 달라집니다.
 */

const slots = [
  { key: "slot:1510", label: "15:10", minute: 15 * 60 + 10 },
  { key: "slot:1515", label: "15:15 갱신", minute: 15 * 60 + 15, onlyIfChanged: true },
  { key: "slot:1520", label: "15:20 최종 · 종가 단일가", minute: 15 * 60 + 20 }
];
/* 15:20 통을 놓친 재기동이 15:25까지는 따라잡습니다. 단일가 안에서도 15:30 전까지 주문은 됩니다. */
const stopMinute = 15 * 60 + 25;
/* 상한가로 보는 문턱. limit-up-queue.mjs와 같은 값입니다. */
const limitUpRate = 29.5;

let running = false;

export function closeBetAlertDue(minute) {
  return minute >= slots[0].minute && minute < stopMinute;
}

/** 지금 시각에 해당하는 칸. 15:13이면 15:10 칸, 15:22면 15:20 칸입니다. */
function slotAt(minute) {
  return [...slots].reverse().find((slot) => minute >= slot.minute) ?? null;
}

export async function notifyCloseBet(config, { minute, url } = {}) {
  if (running || !notifyConfigured(config)) return 0;
  if (!closeBetAlertDue(minute)) return 0;

  running = true;

  try {
    const day = sessionDate("KR");
    const slot = slotAt(minute);
    // 칸마다 한 번. 기록이 저장소에 있어 창 안에서 재기동해도 같은 칸을 또 보내지 않습니다.
    // "sent"는 10-12 이전의 하루 한 통 기록입니다 -- 그 키가 있는 날은 이미 끝난 날입니다.
    const sent = await loadAlertSent(config, "close_bet", day);

    if (!slot || sent.has("sent") || sent.has(slot.key)) return 0;

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
    // 소형에서 들어갈 자리는 잠기기 전이고 그건 [상한가 직전](sangtta-watch.mjs)이
    // 맡습니다. 기록은 nightly-review.mjs가 후보 전부를 따로 남기므로 채점 표본은
    // 재료 유무와 상관없이 그대로 쌓입니다.
    const pool = candidates.filter((row) => row.sessionDate === day && row.tier !== "소형");
    const material = await loadMaterial(config, day, pool.map((row) => row.symbol));
    const today = pool
      .filter((row) => material.has(row.symbol))
      .slice(0, 10)
      .map((row) => ({ ...row, fresh: !sent.has(row.symbol), material: material.get(row.symbol) }));
    const dropped = [...sent.keys()]
      .filter((key) => !key.startsWith("slot:") && !today.some((row) => row.symbol === key))
      .map((symbol) => sent.get(symbol)?.note ?? symbol);
    const changed = dropped.length > 0 || today.some((row) => row.fresh);

    /*
     * 보낼 것이 없으면 보내지 않습니다. "오늘은 없습니다"를 매일 보내면 알림을 읽지
     * 않게 되고, 정작 있는 날을 놓칩니다. 칸도 잠그지 않아 그 칸 안에서 다음 틱에
     * 조건을 넘으면 그때 갑니다. 다만 앞 칸에서 보낸 것이 전부 빠졌으면 그건 알려야
     * 합니다 -- 주문을 넣으려던 사람이 있습니다.
     */
    if (!today.length && !dropped.length) return 0;
    if (slot.onlyIfChanged && !changed) return 0;

    const queues = await loadLockedQueues(config, day, today.filter((row) => row.changeRateValue >= limitUpRate).map((row) => row.symbol))
      .catch(() => new Map());
    const marked = today.map((row) => (row.changeRateValue >= limitUpRate ? { ...row, lock: queues.get(row.symbol) ?? { queue: null } } : row));
    const ok = await notify(config, { text: closeBetMessage(marked, day, { dropped, slot: slot.label, total: pool.length }), url });

    if (!ok) return 0;

    for (const row of today) await markAlertSent(config, "close_bet", day, row.symbol, { note: row.name });
    await markAlertSent(config, "close_bet", day, slot.key, { note: today.map((row) => row.name).join(", ").slice(0, 200) || "전부 빠짐" });
    console.log(`알림: 종가배팅 ${slot.label} · ${today.map((row) => row.name).join(", ") || "-"}${dropped.length ? ` · 빠짐 ${dropped.join(", ")}` : ""}`);

    return today.length;
  } catch (error) {
    console.warn("close bet alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

/*
 * 오른 종목을 줄줄이 나열한 기사. "오전 이슈 [호남 반도체] : 서산, 금호전기, 동양파일,
 * 금호건설, 남화토건"(2026-10-12)이 isReasonHeadline을 통과해 서산·금호전기의 재료로
 * 붙었습니다. 무엇이 올랐는지를 다시 적은 것이지 오른 이유가 아닙니다 -- 복기와 같은
 * 자리입니다. 콜론 뒤에 이름이 셋 이상 쉼표로 이어지거나 '이슈 종목'류 낱말이 있으면 뺍니다.
 */
const listHeadline = /(오전|오후|장중|장마감|마감)\s*이슈|이슈\s*종목|특징주\s*모음|급등주\s*(정리|모음)|상한가\s*종목|테마주\s*(정리|모음)|[:：]\s*[^,，]+([,，][^,，]+){2,}/;

export function isListHeadline(headline) {
  return listHeadline.test(String(headline ?? ""));
}

/** 지금 시각에 해당하는 칸. 15:13이면 15:10 칸, 15:22면 15:20 칸입니다. 미돌파 알림도 같은 칸을 씁니다. */
export function closeBetSlotAt(minute) {
  return minute >= slots[0].minute && minute < stopMinute ? slotAt(minute) : null;
}

/*
 * 재료 -- 직전 장 마감 뒤부터 지금까지의 공시와 기사. 종목마다 가장 이른 것 하나.
 *
 * 가장 이른 것을 고르는 것은 방아쇠가 대개 앞에 있어서입니다. 공시를 기사보다 먼저
 * 봅니다 -- 같은 사건이면 공시가 원본입니다. 직전 장은 일봉에서 읽습니다; 달력으로
 * 하루 전을 잡으면 월요일에 금요일 저녁 공시가 빠집니다.
 */
export async function loadMaterial(config, day, symbols) {
  if (!symbols.length) return new Map();

  const { rows: last } = await query(config, `
    SELECT max(session_date)::text AS day FROM kr_daily_bars WHERE session_date < $1::date`, [day]);
  const since = new Date(`${last[0]?.day ?? day}T15:30:00+09:00`);
  const { rows: filed } = await query(config, `
    SELECT symbol, to_char(filed_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') AS at,
           report_name, title, original_url
      FROM market_disclosures
     WHERE market = 'KR' AND symbol = ANY($1) AND filed_at >= $2 AND filed_at <= now()
     ORDER BY filed_at`, [symbols, since]);
  const { rows: news } = await query(config, `
    SELECT s AS symbol, to_char(published_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') AS at,
           headline, original_url
      FROM market_news_items, unnest(related_symbols) AS s
     WHERE region = 'KR' AND s = ANY($1) AND published_at >= $2 AND published_at <= now()
     ORDER BY published_at`, [symbols, since]);
  const found = new Map();

  for (const row of filed) {
    if (found.has(row.symbol) || String(row.report_name ?? "").startsWith("[기재정정]")) continue;
    if (classifyDisclosure(row.report_name, row.title) !== "good") continue;

    found.set(row.symbol, { at: row.at, kind: "공시", text: row.report_name, url: row.original_url });
  }

  for (const row of news) {
    if (found.has(row.symbol)) continue;
    if (!isReasonHeadline(row.headline) || mentionsBadNews(row.headline) || isMachineHeadline(row.headline)) continue;
    if (isListHeadline(row.headline)) continue;

    found.set(row.symbol, { at: row.at, kind: "기사", text: row.headline, url: row.original_url });
  }

  return found;
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
export function closeBetMessage(candidates, day, { dropped = [], slot = "15:10", total = candidates.length } = {}) {
  const lines = [`[종가배팅 ${slot}] ${day} · 재료 있는 ${candidates.length}종목 (중·대형 후보 ${total} 중)`, ""];
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
        `  ${row.fresh && slot !== "15:10" ? "새 " : ""}${row.name} ${row.symbol} ${won(row.closePrice)}원`
        + ` (${row.changeRateValue > 0 ? "+" : ""}${row.changeRateValue}%)`
        + ` 회전 ${row.turnoverRatio}%`
      );

      if (row.lock && row.lock.locked !== false) {
        const queue = row.lock.queue > 0 ? ` · 매수잔량 ${won(Math.round(row.lock.queue))}주` : "";

        lines.push(`    └ 상한가 잠김 · 종가 체결 어려움${queue}. 체결되면 무너지는 날 (실측 4건 중앙 −0.68%p)`);
      }

      if (row.material) {
        lines.push(`    재료 ${row.material.kind} ${row.material.at} ${String(row.material.text).slice(0, 70)}`);

        if (row.material.url) lines.push(`    ${row.material.url}`);
      }
    }

    lines.push("");
  }

  if (dropped.length) {
    lines.push(`빠짐: ${dropped.join(", ")} — 앞 통에 있었는데 지금은 조건이나 재료를 못 넘습니다`);
    lines.push("");
  }

  lines.push("장중 잠정값입니다(15:30 종가에 확정). 청산은 익일 09:05~09:10.");

  return lines.join("\n");
}
