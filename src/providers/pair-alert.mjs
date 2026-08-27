import { loadLimitPairCandidates } from "./limit-pair.mjs";
import { sendKakaoMemo, kakaoConfigured } from "./kakao.mjs";

/**
 * 짝꿍이 새로 뜨면 카톡 한 통.
 *
 * 이 매매는 장중에 들어가야 하므로 화면을 계속 보고 있을 수 없는 사람에게는 알림이
 * 곧 기능입니다. 2026-08-27 유디엠텍→라온피플은 12:33에 조건이 갖춰졌고 마감까지
 * 세 시간이 남아 있었습니다 -- 그 시각에 알았다면 판단할 시간이 충분했습니다.
 *
 * **같은 짝을 다시 보내지 않는 것이 이 파일의 대부분입니다.** 그 짝은 12:22부터
 * 15:36까지 목록에 계속 떠 있었고, 틱마다 보냈으면 200통이 갔습니다.
 *
 * 등급이 올라갈 때는 다시 보냅니다. "상한가 진행중"과 "실제로 잠김"은 다른 사건이고,
 * 실측에서 성적이 갈리는 지점도 거기입니다(잠기는 순간 +2.58%p로 뜀).
 */

const tierRank = { "상한가 진행중": 1, "상한가·여유": 2, "상한가": 2, "상한가·밀착": 3 };

// 종목-날짜별로 이미 보낸 가장 높은 등급. 날이 바뀌면 통째로 비웁니다.
let sentDay = null;
const sent = new Map();
let running = false;

function rankOf(tier) {
  return tierRank[tier] ?? 2;
}

function line(pair) {
  const gap = Number(pair.leadGap);

  return [
    `[${pair.tier}] ${pair.theme}`,
    `1등주 ${pair.leader.name} +${Number(pair.leader.changeRateValue).toFixed(2)}%`,
    `2등주 ${pair.second.name} +${Number(pair.second.changeRateValue).toFixed(2)}%`,
    `간격 ${gap.toFixed(2)}%p`
  ].join("\n");
}

/**
 * 한 번 훑고 새 것만 보냅니다. 절대 던지지 않습니다 -- 알림 때문에 수집 틱이
 * 멈추면 그 분의 분봉을 잃고, 그것은 다시 받을 수 없습니다.
 */
export async function notifyNewPairs(config, { day, url } = {}) {
  if (running || !kakaoConfigured(config)) return 0;

  running = true;

  try {
    if (sentDay !== day) { sentDay = day; sent.clear(); }

    const pairs = await loadLimitPairCandidates(config);
    let posted = 0;

    for (const pair of pairs) {
      const key = `${pair.leader.symbol}|${pair.second.symbol}`;
      const rank = rankOf(pair.tier);

      // 같은 짝이 같은 등급 이하로 다시 오면 조용히 넘깁니다.
      if ((sent.get(key) ?? 0) >= rank) continue;

      const ok = await sendKakaoMemo(config, { text: line(pair), url });

      // 보낸 것만 기록합니다. 실패한 것을 보냈다고 적으면 영영 다시 안 보냅니다.
      if (!ok) continue;

      sent.set(key, rank);
      posted += 1;
      console.log(`kakao: 짝꿍 알림 · ${pair.leader.name} → ${pair.second.name} [${pair.tier}]`);
    }

    return posted;
  } catch (error) {
    console.warn("pair alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}
