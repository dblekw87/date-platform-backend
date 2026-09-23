import { loadAlertSent, markAlertSent } from "./alert-sent.mjs";
import { loadLimitUpEvidence } from "./limit-up-evidence.mjs";
import { contextLines, loadThemeContext } from "./theme-context.mjs";
import { loadLockedLimitUps } from "./limit-up-detect.mjs";
import { notify, notifyConfigured } from "./notify.mjs";
import { query } from "../db/client.mjs";
import { sessionDate } from "./market-session.mjs";

/**
 * 상한가에 잠긴 종목과, 그 이유로 보이는 것.
 *
 * 규모를 가리지 않습니다 -- 대형이든 소형이든 상한가는 그날 시장이 가장 세게
 * 답한 자리입니다. 실측하면 하루 6~16종목이라 알림이 넘치지 않습니다.
 *
 * **이유가 있을 때만 보냅니다.** 잠겼다는 사실만으로는 보내지 않고, 공시나 기사가
 * 붙을 때까지 기다립니다. 이유를 설명하는 기사는 대개 잠긴 뒤에 나오므로
 * (TPC로보틱스 09:15 잠김 / 10:26 기사) 5분마다 다시 봅니다. 한 종목에 한 통입니다.
 *
 * 잠기기 전(27~29%)도 같은 규칙으로 한 통 보냅니다. 그쪽은 아직 살 수 있는
 * 자리라 근거를 더 좁게 봅니다 -- 공시나 그 종목을 지목한 기사만, 테마 추정은
 * 빼고.
 */

/*
 * 1분. 다른 알림은 2~5분인데 여기만 1분인 이유는 소형주가 그만큼 빠르기 때문입니다
 * -- 24%에서 잠기기까지 중앙값 5분, 27%에서는 1분. 5분 간격이면 문턱을 아무리
 * 내려도 잠긴 뒤에 봅니다. 비용은 그룹 쿼리 하나라 매 틱 물어도 됩니다.
 */
const alertIntervalMs = 60_000;

let lastRunAt = 0;
let running = false;
let awaitingDay = null;
/*
 * 이유가 없어 미뤄둔 잠김. 이것만 메모리에 둡니다 -- 보낸 기록이 아니라 "아직
 * 안 보낸" 목록이고, 잠긴 채인 종목은 다음 틱의 본 루프가 다시 집어 올립니다.
 * 보낸 기록(sent)은 alert-sent.mjs에 있어 재기동해도 남습니다.
 */
const awaitingReason = new Map();

export function limitUpAlertDue(now = Date.now()) {
  return now - lastRunAt >= alertIntervalMs;
}

export async function notifyLimitUps(config, { url } = {}) {
  if (running || !notifyConfigured(config)) return 0;
  if (!limitUpAlertDue()) return 0;

  running = true;
  lastRunAt = Date.now();

  try {
    const day = sessionDate("KR");

    if (awaitingDay !== day) {
      awaitingDay = day;
      awaitingReason.clear();
    }

    const sent = new Set((await loadAlertSent(config, "limit_up", day)).keys());
    const locks = await loadLockedLimitUps(config, day);
    let posted = 0;

    for (const lock of locks) {
      if (sent.has(lock.symbol)) continue;

      const evidence = await loadLimitUpEvidence(config, lock, day);
      evidence.context = await loadThemeContext(config, lock.symbol, day).catch(() => []);

      /*
       * 이유가 없으면 보내지 않습니다.
       *
       * 잠겼다는 사실만으로도 알림을 보내던 것을 바꿨습니다. 상한가는 하루 6~16건인데
       * 그중 절반쯤은 그 시각까지 공시도 기사도 없습니다 -- "왜인지 모르겠습니다"가
       * 절반인 알림은 읽히지 않게 되고, 그러면 이유가 있는 나머지 절반도 같이
       * 안 읽힙니다.
       *
       * 버리는 것이 아니라 미루는 것입니다. 목록에 남겨 두고 5분마다 다시 보다가
       * 공시나 기사가 붙으면 그때 보냅니다 -- 이유를 설명하는 기사는 대개 잠긴
       * 뒤에 나오므로(TPC로보틱스 09:15 잠김 / 10:26 기사) 대부분 몇십 분 안에
       * 나갑니다.
       */
      if (evidence.kind === "none") {
        awaitingReason.set(lock.symbol, lock);
        continue;
      }

      const book = await loadBook(config, day, lock.symbol).catch(() => null);

      if (!await notify(config, { text: firstMessage(lock, evidence, book), url })) continue;

      await markAlertSent(config, "limit_up", day, lock.symbol, { note: evidence.kind });
      sent.add(lock.symbol);
      // 앞선 틱에 이유가 없어 대기 목록에 올라 있었을 수 있습니다. 여기서 안 지우면
      // 바로 아래 followUp이 같은 종목을 한 번 더 보냅니다 -- 2026-09-07 082850이
      // 그렇게 두 통 갔습니다.
      awaitingReason.delete(lock.symbol);
      posted += 1;
      console.log(`알림: 상한가 · ${lock.name} ${lock.minutes}분 · 근거 ${evidence.kind}`);
    }

    posted += await followUp(config, day, url, sent);
    /*
     * 잠기기 전 알림은 2026-09-14부터 sangtta-watch.mjs가 맡습니다. 여기 있던 nearPass
     * (27~29%, 공시·지목 기사 있을 때만)와 상따 감시(소형 24% / 중대형 27%, 근거 없어도)가
     * 같은 종목에 두 통을 보내게 되어 사용자가 한쪽으로 합치자고 했습니다. 근거는 그쪽
     * 메시지에 같은 로더로 붙고, 처음에 없던 근거가 잠기기 전에 붙으면 그쪽이 한 번 더
     * 보냅니다. 이 파일은 **잠긴 뒤**만 봅니다.
     */

    return posted;
  } catch (error) {
    console.warn("limit up alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

/*
 * 이유가 없어 미뤄둔 종목에 기사·공시가 붙었는지 다시 봅니다.
 *
 * 이것이 그 종목의 **첫 통**입니다 -- 잠겼을 때는 아무것도 안 보냈으니까요.
 * 그래서 잠긴 사실까지 같이 적는 firstMessage를 씁니다.
 */
async function followUp(config, day, url, sent) {
  let posted = 0;

  for (const [symbol, lock] of [...awaitingReason]) {
    // 본 루프가 이번 틱에 이미 보냈으면 여기서 또 볼 것이 없습니다.
    if (sent.has(symbol)) {
      awaitingReason.delete(symbol);
      continue;
    }

    const evidence = await loadLimitUpEvidence(config, lock, day);

    evidence.context = await loadThemeContext(config, lock.symbol, day).catch(() => []);

    if (evidence.kind === "none") continue;

    awaitingReason.delete(symbol);

    // 첫 통을 안 보냈으므로 이것이 그 종목의 첫 통입니다 -- 잠긴 사실까지 같이
    // 적어야 합니다.
    const book = await loadBook(config, day, symbol).catch(() => null);

    if (await notify(config, { text: firstMessage(lock, evidence, book), url })) {
      await markAlertSent(config, "limit_up", day, symbol, { note: evidence.kind });
      sent.add(symbol);
      posted += 1;
      console.log(`알림: 상한가(이유 확인) · ${lock.name} · 근거 ${evidence.kind}`);
    }
  }

  return posted;
}

const won = (value) => Number(value ?? 0).toLocaleString("ko-KR");

/*
 * 근거의 등급을 글자로 적습니다. "공시"와 "같은 테마 추정"이 같은 얼굴로 오면
 * 둘을 같은 무게로 읽게 되고, 그것이 이 알림이 가장 크게 틀릴 수 있는 자리입니다.
 */
function evidenceLines(lock, evidence) {
  const lines = [];

  for (const filing of evidence.filings) {
    lines.push(`  공시 ${filing.at} ${(filing.report_name ?? filing.title ?? "").slice(0, 60)}`);

    if (filing.original_url) lines.push(`       ${filing.original_url}`);
  }

  for (const item of evidence.news) {
    const who = evidence.kind === "theme"
      ? `  추정 ${item.at} [같은 테마 ${item.peer_name ?? item.peer} +${item.move.toFixed(0)}%]`
      : evidence.kind === "grouped"
        ? `  묶음 ${item.at}`
        : evidence.kind === "family"
          ? `  지분 ${item.at} [${item.relative?.role ?? "관계사"} ${item.relative?.name ?? item.peer} ${item.relative?.stake_pct != null ? `${Number(item.relative.stake_pct).toFixed(1)}%` : ""}]`
          : `  뉴스 ${item.at}`;

    lines.push(who);
    lines.push(`       ${item.headline}`);

    if (item.original_url) lines.push(`       ${item.original_url}`);
  }

  for (const caution of evidence.cautions ?? []) {
    lines.push(`  주의 ${caution.at} ${(caution.report_name ?? caution.title ?? "").slice(0, 60)}`);
  }

  if (evidence.kind === "theme") lines.push(`  ※ 이 종목을 지목한 기사가 아니라 같은 테마(${lock.theme})에서 같이 오른 종목의 기사입니다.`);
  if (evidence.kind === "family") lines.push("  ※ 이 종목이 아니라 지분으로 이어진 회사의 재료입니다(DART 사업보고서 지분).");
  if (evidence.kind === "grouped") lines.push("  ※ 재료 기사가 아니라 이 종목을 다른 종목과 묶어 부른 기사입니다 -- 이유는 테마 연속성으로 읽으세요.");

  // 맥락 -- 이 종목을 지목하지 않은, 테마를 움직이는 이야기. 근거와 다른 얼굴로 끝에.
  lines.push(...contextLines(evidence.context ?? []));

  return lines;
}

function firstMessage(lock, evidence, book = null) {
  return [
    `[상한가 잠김] ${lock.name} ${lock.symbol} · ${lock.size} · ${lock.market ?? "KR"}`,
    `${won(lock.close_price)}원 · ${lock.minutes}분째 · 거래대금 ${(Number(lock.turnover ?? 0) / 1e8).toFixed(0)}억`,
    lock.theme && lock.theme !== "미분류" ? `테마 ${lock.theme}` : "",
    ...bookLines(book),
    "",
    ...evidenceLines(lock, evidence)
  ].filter(Boolean).join("\n");
}

/*
 * 호가 한 줄 -- 사용자가 알려준 상따 노하우 두 가지를 통에 붙입니다(2026-09-23).
 * "상한가 매수 잔량이 유통주식수의 일정 비율 이상인가"와 "대량 매수세가 갑자기
 * 취소되는가". 잠겼다는 통은 어차피 한 번 나가므로 여기 얹으면 통 수가 안 늘어납니다.
 *
 * **새 알림으로는 안 만들었습니다.** 037 표본 7세션·잠긴 종목-일 58건으로 재 보니,
 * 3분에 20% 넘게 빠져도 그날 종가에 안 잠기는 비율은 7% → 21%로 세 배에 그치고
 * **79%는 그대로 종가까지 잠깁니다**(잠깐 풀리는 것만 1%→16%로 크게 갈립니다).
 * 사용자가 먼저 지적한 그대로 "빠졌다 다시 잠기는 것"이 흔해서, 따로 통을 보낼
 * 값이 아닙니다. `scripts/measure-order-book.mjs`로 몇 주 뒤 다시 잽니다.
 *
 * 두께도 마찬가지로 문턱이 아니라 참고값입니다 -- 0.5% 미만만 유지 33%로 나쁘고
 * 그 위는 64~78%로 평평합니다. 유통주식수가 없어 상장주식수로 나눕니다.
 */
function bookLines(book) {
  if (!book) return [];

  const shares = book.cap > 0 && book.price > 0 ? Number(book.cap) / Number(book.price) : null;
  // 잔량이 상장주식수를 넘으면 데이터가 틀린 것입니다(앤씨앤 2026-09-17). 두께를 뺍니다.
  const thickness = shares && Number(book.bid_total) <= shares ? 100 * Number(book.bid_total) / shares : null;
  const parts = [`잔량 ${Math.round(Number(book.bid_total)).toLocaleString("ko-KR")}주`];

  if (thickness !== null) parts.push(`상장의 ${thickness.toFixed(2)}%${thickness < 0.5 ? " (얇음 · 유지 33%)" : ""}`);
  if (book.drop !== null && book.drop !== undefined) {
    const drop = Number(book.drop);

    parts.push(drop >= 1
      ? `3분 −${drop.toFixed(0)}%${drop >= 20 ? " (종가까지 안 잠김 21%)" : ""}`
      : "3분 변화 없음");
  }

  return [`호가 ${parts.join(" · ")}`];
}

/*
 * 지금 잠겨 있는 그 종목의 마지막 호가 표본과 3분 전 대비 변화.
 * 표본은 sangtta-watch가 24% 위 종목을 1분마다 찍어 둔 것이라 추가 요청이 없습니다.
 */
async function loadBook(config, day, symbol) {
  const { rows } = await query(config, `
    WITH latest AS (
      SELECT observed_at, total_bid_qty::float8 AS bid_total, price::float8 AS price
        FROM kr_order_book_samples
       WHERE session_date = $1::date AND symbol = $2
       ORDER BY observed_at DESC LIMIT 1
    )
    SELECT l.bid_total, l.price,
           (SELECT b.total_bid_qty::float8 FROM kr_order_book_samples b
             WHERE b.session_date = $1::date AND b.symbol = $2
               AND b.observed_at <= l.observed_at - interval '3 minutes'
             ORDER BY b.observed_at DESC LIMIT 1) AS bid_before,
           (SELECT max(p.market_cap)::float8 FROM market_price_samples p
             WHERE p.symbol = $2 AND p.session_date = $1::date) AS cap
      FROM latest l`, [day, symbol]);
  const row = rows[0];

  if (!row || !(Number(row.bid_total) > 0)) return null;

  const before = Number(row.bid_before);

  return {
    bid_total: row.bid_total,
    cap: row.cap,
    drop: before > 0 ? 100 * (before - Number(row.bid_total)) / before : null,
    price: row.price
  };
}


/** 하루가 끝나면 남깁니다. "상한가가 다음 날 어떻게 됐나"는 나중에 잴 수 있는 질문입니다. */
export async function recordLimitUps(config, day) {
  const locks = await loadLockedLimitUps(config, day);
  let saved = 0;

  for (const lock of locks) {
    const result = await query(config, `
      INSERT INTO kr_signal_outcomes (kind, session_date, symbol, detected_at, tier, theme, entry_rate)
      VALUES ('limit_up', $1::date, $2, $3, $4, $5, 30)
      ON CONFLICT (kind, session_date, symbol) DO NOTHING`,
      [day, lock.symbol, lock.locked_at, lock.size, lock.theme ?? null]);

    saved += result.rowCount ?? 0;
  }

  return saved;
}
