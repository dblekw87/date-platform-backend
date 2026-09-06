import { kakaoConfigured, sendKakaoMemo } from "./kakao.mjs";
import { sendTelegram, telegramConfigured } from "./telegram.mjs";

/**
 * 알림 한 통을, 열려 있는 길로.
 *
 * 알림마다 어느 길로 보낼지 고르게 두면 하나를 옮길 때 나머지가 뒤에 남습니다.
 * 실제로 그랬습니다 -- 재료 알림만 텔레그램으로 옮겼더니 짝꿍·주도주·미국 급등은
 * 카카오에 남아, 카카오 토큰이 만료되는 날 그 셋만 조용히 멈추는 상태가 됐습니다.
 *
 * **텔레그램이 있으면 텔레그램으로만 갑니다.** 둘 다 보내면 같은 알림이 두 번
 * 오고, 두 번 오는 알림은 읽지 않게 됩니다. 카카오는 텔레그램이 설정되지 않은
 * 기계를 위한 뒷길입니다.
 */

export function notifyConfigured(config) {
  return telegramConfigured(config) || kakaoConfigured(config);
}

export async function notify(config, { text, url }) {
  if (telegramConfigured(config)) {
    // 카카오는 링크를 따로 받지만 텔레그램은 본문에 붙입니다. 미리보기는
    // telegram.mjs가 끕니다.
    return sendTelegram(config, { text: url ? `${text}\n${url}` : text });
  }

  return sendKakaoMemo(config, { text, url });
}
