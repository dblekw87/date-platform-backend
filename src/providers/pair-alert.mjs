import { loadLimitPairCandidates } from "./limit-pair.mjs";
import { notify, notifyConfigured } from "./notify.mjs";

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

/*
 * 테마 이름 옆에 그 테마가 오늘 얼마나 앞섰는지를 붙입니다.
 *
 * 짝은 공유 테마가 하나라도 있으면 서므로 한 종목이 여러 알림의 1등주로 나옵니다.
 * 2026-08-31 사토시홀딩스가 15:08 드론, 15:13 건강기능식품으로 두 번 갔고 -- 편입이
 * 넷이라 둘 다 맞는 알림이지만, 받는 쪽에서는 "왜 같은 종목이 다른 테마냐"로 읽힙니다.
 * 그날 건강기능식품은 초과 +6.47%p, 드론은 +2.68%p였습니다. 그 숫자가 있으면 어느
 * 알림이 진짜인지 메시지 한 줄로 갈립니다.
 *
 * 회원 수까지 적는 것은 셋짜리 테마의 평균이 크게 나오기 쉬워서입니다.
 */
function themeNote(pair) {
  // 짝 두 종목을 뺀 **나머지**입니다. 그 말을 붙이지 않으면 "테마가 올랐다"로
  // 읽히는데, 짝을 포함해 재던 시절이 정확히 그 오해였습니다.
  if (pair.themeMembers === 0) return " 나머지 없음";
  if (pair.themeMove === null || pair.themeMove === undefined) return "";

  const move = Number(pair.themeMove);
  const members = pair.themeMembers ? `·${pair.themeMembers}종목` : "";

  return ` 나머지 ${move >= 0 ? "+" : ""}${move.toFixed(2)}%p${members}`;
}

/*
 * 기준을 매 통에 답니다.
 *
 * 등급 이름만 보내면 화면의 성적(밀착 612건 +5.55%p·상회 76%)이 따라옵니다. 그런데
 * 그 값은 **종가에 사서 익일 시가에 판** 것이고 이 알림은 장중에 옵니다 -- 받는 쪽이
 * 지금 들어가는 근거로 읽으면 재지 않은 매매를 하는 셈입니다.
 *
 * 2026-09-02에 그 구간을 실제로 쟀고 성립하지 않았습니다. 처음에는 **알림이
 * 발동하는 자리**를 쟀는데(1등주 잠긴 직후 첫 틱, 2등주가 +10%든 +27%든) 그건
 * 사용자가 하는 진입이 아니었습니다. 사용자가 정한 조건(간격 6%p 이내)으로 다시
 * 재니 **314건 · 12개 장 · 마감까지 -1.47%**이고, 같은 분에 비슷하게 올라 있던
 * 무관한 종목(29,237건 +0.06%)보다 나쁩니다. 화면에는 적었는데 알림에만 없으면
 * 정작 장중에 도착하는 쪽이 조용합니다.
 *
 * **두 줄로 나눕니다.** 한 줄로 붙였더니 "종가매수가 뭐냐"는 질문이 나왔습니다 --
 * 위 등급이 무엇을 잰 값인지와, 지금 사면 어떤지는 다른 이야기입니다.
 *
 * 알림을 없애지 않는 이유는 이 자리가 **종가 매수 후보를 미리 아는 자리**이기
 * 때문입니다. 없앨지는 사용자가 정할 일입니다.
 */
const BASIS = "※ 위 등급 성적은 종가에 사서 익일 아침에 판 값입니다.\n" +
  "※ 지금 장중에 사는 것은 실측 -1.47%(314건, 대조군 +0.06%)";

function line(pair) {
  const gap = Number(pair.leadGap);

  return [
    `[${pair.tier}] ${pair.theme}${themeNote(pair)}`,
    `1등주 ${pair.leader.name} +${Number(pair.leader.changeRateValue).toFixed(2)}%`,
    `2등주 ${pair.second.name} +${Number(pair.second.changeRateValue).toFixed(2)}%`,
    `간격 ${gap.toFixed(2)}%p`,
    BASIS
  ].join("\n");
}

/**
 * 한 번 훑고 새 것만 보냅니다. 절대 던지지 않습니다 -- 알림 때문에 수집 틱이
 * 멈추면 그 분의 분봉을 잃고, 그것은 다시 받을 수 없습니다.
 */
export async function notifyNewPairs(config, { day, url } = {}) {
  if (running || !notifyConfigured(config)) return 0;

  running = true;

  try {
    if (sentDay !== day) { sentDay = day; sent.clear(); }

    const pairs = await loadLimitPairCandidates(config);
    let posted = 0;

    for (const pair of pairs) {
      /*
       * 오늘 장의 짝만 보냅니다.
       *
       * 2026-08-28 08:00에 어제(08-27) 짝인 유디엠텍→라온피플이 발송됐습니다.
       * 자정에 날짜가 바뀌며 중복 방지가 비워지는데, 그 시각에는 오늘 정규장
       * 데이터가 없어 확정 경로가 어제 종가로 만든 목록을 그대로 돌려줍니다.
       * 비워진 기록에 어제 짝이 "새 것"으로 들어온 것입니다.
       *
       * 화면에서는 어제 결과가 남아 있는 것이 맞습니다 -- 장 열리기 전에 보드가
       * 비어 있으면 그게 더 나쁩니다. 알림만 오늘 것을 요구합니다.
       */
      if (pair.sessionDate && pair.sessionDate !== day) continue;

      /*
       * 짝의 신원은 **순서와 무관**합니다.
       *
       * `leader|second`로 두면 둘이 1·2등을 바꿀 때마다 새 짝이 됩니다.
       * 2026-09-01에 16통 중 3통이 그 왕복이었습니다 -- 바이오니아↔모아라이프플러스,
       * 유티아이↔비에이치, 인디에프↔온타이드가 각각 두 번씩 왔습니다.
       *
       * 자리를 바꿔가며 서로를 앞선다는 것은 한쪽이 끌고 다른 쪽이 따라오는 모양이
       * 아니라 **둘이 같이 가고 있다**는 뜻입니다. 첫 통이 이미 그 쌍을 알렸으므로
       * 두 번째는 새로 알릴 것이 없습니다.
       *
       * 등급이 오르면 순서와 무관하게 다시 보냅니다 -- 진행중에서 밀착으로 가는 것은
       * 실제로 달라진 사실이고, 그 판단은 아래 rank 비교가 그대로 합니다.
       */
      const key = [pair.leader.symbol, pair.second.symbol].sort().join("|");
      const rank = rankOf(pair.tier);

      // 같은 짝이 같은 등급 이하로 다시 오면 조용히 넘깁니다.
      if ((sent.get(key) ?? 0) >= rank) continue;

      const ok = await notify(config, { text: line(pair), url });

      // 보낸 것만 기록합니다. 실패한 것을 보냈다고 적으면 영영 다시 안 보냅니다.
      if (!ok) continue;

      sent.set(key, rank);
      posted += 1;
      console.log(`알림: 짝꿍 알림 · ${pair.leader.name} → ${pair.second.name} [${pair.tier}]`);
    }

    return posted;
  } catch (error) {
    console.warn("pair alert failed", error instanceof Error ? error.message : error);

    return 0;
  } finally {
    running = false;
  }
}
