import { loadLimitUpEvidence } from "./limit-up-evidence.mjs";
import { loadLockedLimitUps, loadNearLimitUps } from "./limit-up-detect.mjs";
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
let sentDay = null;
const sent = new Set();
const sentNear = new Set();
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

    if (sentDay !== day) {
      sentDay = day;
      sent.clear();
      sentNear.clear();
      awaitingReason.clear();
    }

    const locks = await loadLockedLimitUps(config, day);
    let posted = 0;

    for (const lock of locks) {
      if (sent.has(lock.symbol)) continue;

      const evidence = await loadLimitUpEvidence(config, lock, day);

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

      if (!await notify(config, { text: firstMessage(lock, evidence), url })) continue;

      sent.add(lock.symbol);
      // 앞선 틱에 이유가 없어 대기 목록에 올라 있었을 수 있습니다. 여기서 안 지우면
      // 바로 아래 followUp이 같은 종목을 한 번 더 보냅니다 -- 2026-09-07 082850이
      // 그렇게 두 통 갔습니다.
      awaitingReason.delete(lock.symbol);
      posted += 1;
      console.log(`알림: 상한가 · ${lock.name} ${lock.minutes}분 · 근거 ${evidence.kind}`);
    }

    posted += await followUp(config, day, url);
    posted += await nearPass(config, day, url);

    return posted;
  } catch (error) {
    console.warn("limit up alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

/*
 * 잠기기 전에 한 번.
 *
 * 잠긴 뒤에는 매도호가가 비어 살 수 없으므로, 값은 **잠기기 전**에 있습니다.
 * 27%를 넘긴 종목 중 아직 29%에 못 간 것만 봅니다 -- 넘긴 것은 잠김 쪽이 맡습니다.
 *
 * **근거 없이는 보내지 않고, 근거는 공시나 그 종목을 지목한 기사여야 합니다.**
 * 하루 7~14종목이 27%에 닿는데 그 시각까지 근거가 있는 것은 4종목쯤입니다
 * (2026-09-02~04 실측). 나머지는 기사가 나오기도 전에 올라간 것들이라, 같이
 * 보내면 알림이 세 배가 되고 그중 대부분은 왜 오르는지 말하지 못합니다.
 *
 * 같은 테마 추정은 여기서 빼둡니다. 잠긴 뒤에는 "왜 올랐나"를 설명하는 자리라
 * 약한 근거도 값이 있지만, 여기는 **지금 살까**를 묻는 자리입니다.
 */
async function nearPass(config, day, url) {
  const near = await loadNearLimitUps(config, day);
  let posted = 0;

  for (const stock of near) {
    if (sentNear.has(stock.symbol) || sent.has(stock.symbol)) continue;

    const evidence = await loadLimitUpEvidence(config, stock, day);

    if (evidence.kind !== "filing" && evidence.kind !== "direct") continue;

    if (!await notify(config, { text: nearMessage(stock, evidence), url })) continue;

    sentNear.add(stock.symbol);
    posted += 1;
    console.log(`알림: 상한가 근접 · ${stock.name} +${stock.top_rate.toFixed(1)}% · 근거 ${evidence.kind}`);
  }

  return posted;
}

/*
 * 이유가 없어 미뤄둔 종목에 기사·공시가 붙었는지 다시 봅니다.
 *
 * 이것이 그 종목의 **첫 통**입니다 -- 잠겼을 때는 아무것도 안 보냈으니까요.
 * 그래서 잠긴 사실까지 같이 적는 firstMessage를 씁니다.
 */
async function followUp(config, day, url) {
  let posted = 0;

  for (const [symbol, lock] of [...awaitingReason]) {
    // 본 루프가 이번 틱에 이미 보냈으면 여기서 또 볼 것이 없습니다.
    if (sent.has(symbol)) {
      awaitingReason.delete(symbol);
      continue;
    }

    const evidence = await loadLimitUpEvidence(config, lock, day);

    if (evidence.kind === "none") continue;

    awaitingReason.delete(symbol);

    // 첫 통을 안 보냈으므로 이것이 그 종목의 첫 통입니다 -- 잠긴 사실까지 같이
    // 적어야 합니다.
    if (await notify(config, { text: firstMessage(lock, evidence), url })) {
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
      : `  뉴스 ${item.at}`;

    lines.push(who);
    lines.push(`       ${item.headline}`);

    if (item.original_url) lines.push(`       ${item.original_url}`);
  }

  for (const caution of evidence.cautions ?? []) {
    lines.push(`  주의 ${caution.at} ${(caution.report_name ?? caution.title ?? "").slice(0, 60)}`);
  }

  if (evidence.kind === "theme") lines.push(`  ※ 이 종목을 지목한 기사가 아니라 같은 테마(${lock.theme})에서 같이 오른 종목의 기사입니다.`);

  return lines;
}

function firstMessage(lock, evidence) {
  return [
    `[상한가 잠김] ${lock.name} ${lock.symbol} · ${lock.size} · ${lock.market ?? "KR"}`,
    `${won(lock.close_price)}원 · ${lock.minutes}분째 · 거래대금 ${(Number(lock.turnover ?? 0) / 1e8).toFixed(0)}억`,
    lock.theme && lock.theme !== "미분류" ? `테마 ${lock.theme}` : "",
    "",
    ...evidenceLines(lock, evidence)
  ].filter(Boolean).join("\n");
}

function nearMessage(stock, evidence) {
  return [
    `[상한가 직전] ${stock.name} ${stock.symbol} · ${stock.size} · ${stock.market ?? "KR"}`,
    `+${stock.top_rate.toFixed(1)}% · 상한가까지 ${stock.gap}%p · 거래대금 ${(Number(stock.turnover ?? 0) / 1e8).toFixed(0)}억`,
    stock.theme && stock.theme !== "미분류" ? `테마 ${stock.theme}` : "",
    "",
    ...evidenceLines(stock, evidence)
  ].filter(Boolean).join("\n");
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
