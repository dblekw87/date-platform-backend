/**
 * 텔레그램 봇으로 한 통.
 *
 * 카카오 '나에게 보내기'를 대신합니다. 두 가지가 달라서 옮겼습니다.
 *
 *   길이    카카오는 한 통 200자라 종목 하나가 한 통이었습니다. 2026-09-06 주말
 *           후보 6종목이 7통으로 갔습니다. 텔레그램은 4096자라 근거까지 붙여도
 *           한 통에 들어갑니다
 *   토큰    카카오 리프레시 토큰은 두 달마다 만료됩니다 -- 놓치면 알림이 조용히
 *           멈추고, 멈춘 것을 알아채는 방법이 없습니다. 봇 토큰은 만료가 없습니다
 *
 * 카카오 쪽은 지우지 않고 그대로 뒀습니다. 짝꿍·주도주 알림이 아직 그 길로
 * 나가고, 둘 다 설정돼 있으면 둘 다 갑니다.
 */

const apiBase = "https://api.telegram.org/bot";
// 텔레그램 한 통 한도는 4096자입니다. 여유를 두는 것은 자를 때 줄 단위로 끊기
// 때문에 마지막 줄이 한도를 살짝 넘길 수 있어서입니다.
const chunkLimit = 3800;

let lastError = null;

export function telegramConfigured(config) {
  return Boolean(config.telegram?.botToken && config.telegram?.chatId);
}

export function telegramLastError() {
  return lastError;
}

/*
 * 줄 단위로 자릅니다.
 *
 * 글자 수로 자르면 종목 이름이나 근거 문장 한가운데가 끊겨 무엇이 왔는지 알 수
 * 없게 됩니다. 카카오에서 실제로 그랬습니다.
 */
export function splitMessage(text, limit = chunkLimit) {
  const chunks = [];
  let current = "";

  for (const line of String(text).split("\n")) {
    if (current && current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = "";
    }

    current = current ? `${current}\n${line}` : line;
  }

  if (current) chunks.push(current);

  return chunks;
}

/**
 * 실패는 던지지 않고 false로 돌려줍니다 -- 알림이 안 갔다고 수집이 멈추면
 * 안 됩니다. 그 시각의 분봉은 다시 못 받지만 알림은 다음 것이 또 옵니다.
 */
export async function sendTelegram(config, { text }) {
  if (!telegramConfigured(config)) return false;

  const chunks = splitMessage(text);

  try {
    for (const chunk of chunks) {
      const response = await fetch(`${apiBase}${config.telegram.botToken}/sendMessage`, {
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          // 링크 미리보기가 붙으면 한 통이 화면 두 배가 됩니다.
          disable_web_page_preview: true,
          text: chunk
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });

      if (!response.ok) throw new Error(`send ${response.status} ${(await response.text()).slice(0, 160)}`);

      // 텔레그램은 같은 대화방에 초당 한 통쯤을 권합니다. 여러 통으로 갈릴 때만
      // 걸리는 자리라 평소에는 지나갑니다.
      if (chunks.length > 1) await new Promise((resolve) => setTimeout(resolve, 400));
    }

    lastError = null;

    return true;
  } catch (error) {
    lastError = { at: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) };
    console.warn("telegram: 발송 실패", lastError.message);

    return false;
  }
}
