import { collectCandidates, tradableUniverse } from "./overnight-collect.mjs";
import { query } from "../db/client.mjs";
import { rankPicks, tierOf } from "./overnight-rank.mjs";
import { materialPhase } from "./overnight-gate.mjs";
import { sendTelegram, telegramConfigured } from "./telegram.mjs";
import { tradingSessions, upcomingWindow } from "./overnight-window.mjs";

/**
 * 장이 닫혀 있는 동안 나온 재료를 계속 지켜보다가, 새로 잡힌 것만 보냅니다.
 *
 * 하루 한 번 몰아 보내지 않는 이유는 재료가 하루 한 번 나오지 않기 때문입니다.
 * 15:40에 장이 끝나면 애프터마켓(NXT)이 20:00까지 열려 있고, 공시는 20:10까지
 * 들어오며, 뉴스는 밤새 나옵니다. 아침 프리마켓까지도 새 기사가 붙습니다. 몰아
 * 보내면 그 사이에 살 수 있었던 자리를 전부 지나칩니다.
 *
 * **같은 종목을 두 번 보내지 않는 것은 표식이 아니라 저장이 합니다.**
 * kr_signal_outcomes의 (kind, session_date, symbol) 유일 제약에 걸려 두 번째
 * INSERT가 0행을 돌려주고, 우리는 실제로 들어간 행만 보냅니다. 채점하려고 어차피
 * 남기는 것이라 중복 방지용 상태를 따로 두면 둘이 어긋날 자리만 늘어납니다.
 */

const alertIntervalMs = 5 * 60_000;

/*
 * 켜자마자 보내지 않습니다.
 *
 * 콜드 부팅 직후에는 껐던 동안의 뉴스가 아직 안 들어와 있습니다 -- start-collector가
 * 백엔드를 띄운 **뒤에** backfill-news.mjs를 부르고, 그것이 이틀치를 받아오는 데
 * 몇 분이 걸립니다. 그 전에 훑으면 얇은 corpus로 후보를 정해 놓고, 정작 주말에 나온
 * 재료는 "이미 보낸 세션"이 되어 영영 안 갑니다. 첫 판정을 한 간격 미룹니다.
 */
let lastRunAt = Date.now();
let running = false;

export function materialAlertDue(now = Date.now()) {
  return now - lastRunAt >= alertIntervalMs;
}

export async function notifyNewMaterial(config, { url } = {}) {
  if (running || !telegramConfigured(config)) return 0;

  running = true;
  lastRunAt = Date.now();

  try {
    const sessions = await tradingSessions(config);
    const window = upcomingWindow(sessions);
    const candidates = await collectCandidates(config, window);
    const universe = await tradableUniverse(config, window.previous, minTurnover);
    const picks = rankPicks(candidates, universe);
    const phase = materialPhase();
    const fresh = await unsent(config, window.previous, phase, picks);

    if (!fresh.length) return 0;

    /*
     * **보낸 뒤에 기록합니다.**
     *
     * 처음엔 기록이 먼저였습니다 -- 유일 제약이 중복을 걸러 주니 INSERT가 들어간
     * 것만 보내면 된다는 계산이었는데, 발송이 실패하면 이미 기록된 채라 다음
     * 틱에 "이미 보낸 것"으로 건너뜁니다. 텔레그램이 한 번 삐끗하면 그 후보는
     * 영영 안 갑니다. 같은 프로세스 안의 중복은 running 플래그가 막으므로 순서를
     * 바꿔도 두 번 가지 않습니다.
     */
    const sent = await sendTelegram(config, { text: message(fresh, window, phase, url) });

    if (!sent) return 0;

    for (const pick of fresh) await record(config, window.previous, phase, pick);

    console.log(`알림: 재료 · ${fresh.map((pick) => pick.listing.name).join(", ")}`);

    return fresh.length;
  } catch (error) {
    console.warn("material alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}

// 거래대금 바닥. 판단 조건이 아니라 모집단 조건입니다 -- 이보다 얇으면 주문이
// 나가지 않습니다. [[leader-pool-filters]]
const minTurnover = 1_000_000_000;

/** 아직 기록에 없는 것만. 기록은 보낸 뒤에 하므로 "기록 없음"이 곧 "안 보냈음"입니다. */
async function unsent(config, sessionDate, phase, picks) {
  if (!picks.length) return [];

  const { rows } = await query(config, `
    SELECT symbol FROM kr_signal_outcomes
     WHERE kind = $1 AND session_date = $2::date AND symbol = ANY($3)`,
    [`${phase}_material`, sessionDate, picks.map((pick) => pick.symbol)]);
  const seen = new Set(rows.map((row) => row.symbol));

  return picks.filter((pick) => !seen.has(pick.symbol));
}

/*
 * 남깁니다. 유일 제약은 그대로 두어 재시작 직후 같은 것을 두 번 넣지 않게 합니다.
 *
 * kind에 구간을 넣는 것은 나중에 갈라 재기 위해서입니다. 유일 제약이
 * (kind, session_date, symbol)이므로 같은 종목이 장중에 한 번, 마감 뒤에 한 번
 * 잡히면 둘 다 남고 알림도 두 번 갑니다 -- 다른 사건이니 맞습니다.
 */
async function record(config, sessionDate, phase, pick) {
  const evidence = pick.good[0]?.title?.split("·").pop().trim()
    ?? pick.material[0]?.headline
    ?? "";

  const result = await query(config, `
    INSERT INTO kr_signal_outcomes (kind, session_date, symbol, detected_at, tier, theme, entry_rate)
    VALUES ($1, $2::date, $3, now(), $4, $5, $6)
    ON CONFLICT (kind, session_date, symbol) DO NOTHING`,
    [`${phase}_material`, sessionDate, pick.symbol, tierOf(pick), evidence.slice(0, 200), pick.listing.change_rate]);

  return (result.rowCount ?? 0) > 0;
}

const won = (value) => Number(value ?? 0).toLocaleString("ko-KR");

/*
 * 근거를 종목 밑에 같이 적습니다. 종목 코드만 온 알림은 새벽에 받아도 무엇을 보고
 * 고른 것인지 되짚을 수 없고, 되짚을 수 없으면 틀렸을 때 무엇을 고쳐야 하는지도
 * 알 수 없습니다.
 */
function message(picks, window, phase, url) {
  /*
   * 첫 줄에 **어떤 알림인지**를 적습니다.
   *
   * 알림이 여섯 종류라 내용을 읽기 전에 종류부터 알아야 합니다 -- 종가배팅은
   * 오늘 종가에 사는 것이고, 다음 장 후보는 내일 아침에 판단하는 것이고, 둘이
   * 같은 얼굴로 오면 오늘 살 것을 내일로 미루거나 그 반대가 됩니다.
   */
  const heading = phase === "intraday"
    ? `[장중 재료] 새 후보 ${picks.length}종목 · 오늘 장중에 나온 재료`
    : `[다음 장 후보] 새 후보 ${picks.length}종목 · ${window.previous} 마감 뒤 나온 재료`;
  const lines = [heading, ""];

  for (const pick of picks) {
    const listing = pick.listing;

    lines.push(
      `[${tierOf(pick)}] ${listing.name} ${pick.symbol} · ${listing.market}`
      + ` ${won(listing.close_price)}원 (${listing.change_rate > 0 ? "+" : ""}${listing.change_rate}%)`
      + ` 거래대금 ${(listing.turnover / 1e8).toFixed(0)}억`
    );

    /* 원문 주소를 같이 보냅니다. 제목만으로는 재료의 크기를 알 수 없고 -- 수주
     * 한 건이 300억인지 3,000억인지가 제목에서 빠지는 일이 흔합니다 -- 알림을
     * 받은 자리에서 바로 확인할 수 없으면 결국 다시 검색하게 됩니다. */
    for (const filing of pick.good.slice(0, 2)) {
      lines.push(`  공시 ${filing.title.split("·").pop().trim()}`);

      if (filing.original_url) lines.push(`       ${filing.original_url}`);
    }

    for (const article of pick.material.slice(0, 2)) {
      lines.push(`  뉴스 ${article.headline}`);

      if (article.original_url) lines.push(`       ${article.original_url}`);
    }

    if (pick.sourceCount > 1) lines.push(`  매체 ${pick.sourceCount}곳`);

    lines.push("");
  }

  /* 등급이 무엇을 뜻하는지 매번 적습니다. 알림은 한 통만 따로 읽히므로 앞 통에
   * 적어 둔 설명은 없는 것과 같습니다. */
  lines.push("A=호재공시+매체3곳↑ B=호재공시 또는 매체4곳↑ C=재료뉴스");
  lines.push("복기·희석·악재 공시, 직전 상한가는 제외했습니다.");

  /* 장중 구간은 아직 재본 적이 없습니다. 같은 얼굴로 오면 같은 근거가 있는 줄
   * 알게 되므로 알림에 적습니다. */
  if (phase === "intraday") {
    lines.push("※ 장중 재료는 아직 검증 전입니다. 마감 후 재료만 10세션으로 쟀습니다.");
  }

  if (url) lines.push(url);

  return lines.join("\n");
}
