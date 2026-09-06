import { loadLimitUpEvidence } from "./limit-up-evidence.mjs";
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
 * **두 번 보낼 수 있습니다.** 잠긴 사실은 시각이 값이라 바로 보내야 하는데,
 * 이유가 되는 기사는 대개 뒤에 나옵니다(TPC로보틱스 09:15 잠김 / 10:26 기사).
 * 그래서 이유 없이 나간 종목은 목록에 남겨 두고, 나중에 이유가 잡히면 그것만
 * 짧게 한 번 더 보냅니다. 세 번은 없습니다.
 */

const alertIntervalMs = 5 * 60_000;

let lastRunAt = 0;
let running = false;
let sentDay = null;
const sent = new Set();
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
      awaitingReason.clear();
    }

    const locks = await loadLockedLimitUps(config, day);
    let posted = 0;

    for (const lock of locks) {
      if (sent.has(lock.symbol)) continue;

      const evidence = await loadLimitUpEvidence(config, lock, day);

      if (!await notify(config, { text: firstMessage(lock, evidence), url })) continue;

      sent.add(lock.symbol);
      posted += 1;

      // 이유 없이 나간 것만 다시 볼 목록에 올립니다.
      if (evidence.kind === "none") awaitingReason.set(lock.symbol, lock);

      console.log(`알림: 상한가 · ${lock.name} ${lock.minutes}분 · 근거 ${evidence.kind}`);
    }

    posted += await followUp(config, day, url);

    return posted;
  } catch (error) {
    console.warn("limit up alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

/** 이유 없이 나간 종목에 뒤늦게 기사가 붙었는지. 붙으면 그것만 한 번 더. */
async function followUp(config, day, url) {
  let posted = 0;

  for (const [symbol, lock] of [...awaitingReason]) {
    const evidence = await loadLimitUpEvidence(config, lock, day);

    if (evidence.kind === "none") continue;

    awaitingReason.delete(symbol);

    if (await notify(config, { text: laterMessage(lock, evidence), url })) posted += 1;
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

  if (evidence.kind === "none") lines.push("  이유로 볼 만한 공시·기사가 아직 없습니다.");
  if (evidence.kind === "theme") lines.push(`  ※ 이 종목을 지목한 기사가 아니라 같은 테마(${lock.theme})에서 같이 오른 종목의 기사입니다.`);

  return lines;
}

function firstMessage(lock, evidence) {
  return [
    `[상한가] ${lock.name} ${lock.symbol} · ${lock.size} · ${lock.market ?? "KR"}`,
    `${won(lock.close_price)}원 · ${lock.minutes}분째 · 거래대금 ${(Number(lock.turnover ?? 0) / 1e8).toFixed(0)}억`,
    lock.theme && lock.theme !== "미분류" ? `테마 ${lock.theme}` : "",
    "",
    ...evidenceLines(lock, evidence)
  ].filter(Boolean).join("\n");
}

function laterMessage(lock, evidence) {
  return [
    `[상한가·이유] ${lock.name} ${lock.symbol}`,
    "",
    ...evidenceLines(lock, evidence)
  ].join("\n");
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
