import { loadUsPremarketMovers } from "./premarket.mjs";
import { sendKakaoMemo, kakaoConfigured } from "./kakao.mjs";

/**
 * 미국 개장 조건이 맞으면 카톡 한 통.
 *
 * 조건은 실측에서 나온 것입니다 -- 2024-08~2026-08 1,503건, 정규장 첫 봉 시가 진입,
 * 30분 뒤 종가, 중앙값:
 *
 *   프리 50~100%  +21.2%      프리 150~300%  −3.1%
 *   프리 100~150% +12.7%      프리 300%↑     −5.7%
 *
 * 많이 오를수록 나빠집니다. 프리마켓에서 다 가버려 정규장에 남은 것이 없기
 * 때문입니다. 그래서 위쪽을 150%에서 자릅니다.
 *
 * 첫 5분봉이 그 다음을 가릅니다. 프리 150~300%에서 양봉이면 30분 종가 +3.7%에
 * 승률 56%, 음봉이면 −9.8%에 33%였습니다.
 *
 * **한국 시간으로 밤 11시 넘어 울립니다.** 미국 개장이 22:30이고 첫 봉은 22:35에
 * 닫힙니다. 자는 동안 오는 알림이므로 조건을 좁게 잡았습니다 -- 넓히면 새벽마다
 * 여러 통이 됩니다.
 */

const minPreGain = 0.5;
const maxPreGain = 1.5;

let sentDay = null;
const sent = new Set();
let running = false;

function line(mover) {
  const pre = (mover.preGain * 100).toFixed(0);
  const now = (mover.changeRate * 100).toFixed(0);

  return [
    `[미국 개장] ${mover.symbol}`,
    mover.name === mover.symbol ? null : mover.name,
    `프리마켓 +${pre}% · 첫 5분봉 양봉`,
    `개장가 $${Number(mover.openPrice).toFixed(2)} · 현재 ${now >= 0 ? "+" : ""}${now}%`
  ].filter(Boolean).join("\n");
}

/** 절대 던지지 않습니다 -- 알림 때문에 수집 틱이 멈추면 그 분의 분봉을 잃습니다. */
export async function notifyOpenSignals(config, { day, url } = {}) {
  if (running || !kakaoConfigured(config)) return 0;

  running = true;

  try {
    if (sentDay !== day) { sentDay = day; sent.clear(); }

    const { movers } = await loadUsPremarketMovers(config);
    let posted = 0;

    for (const mover of movers ?? []) {
      if (mover.openBarState !== "green" || mover.preGain === null) continue;
      if (mover.preGain < minPreGain || mover.preGain > maxPreGain) continue;
      if (sent.has(mover.symbol)) continue;
      if (!Number.isFinite(Number(mover.openPrice))) continue;

      // 보낸 것만 기록합니다. 실패한 것을 보냈다고 적으면 영영 다시 안 보냅니다.
      if (!await sendKakaoMemo(config, { text: line(mover), url })) continue;

      sent.add(mover.symbol);
      posted += 1;
      console.log(`kakao: 미국 개장 신호 · ${mover.symbol} 프리 +${(mover.preGain * 100).toFixed(0)}%`);
    }

    return posted;
  } catch (error) {
    console.warn("open signal alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}
