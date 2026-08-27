/**
 * 카카오톡 "나에게 보내기".
 *
 * 채널 알림톡은 사업자 등록과 템플릿 심사가 필요하고, 이건 본인 계정으로 본인에게만
 * 보냅니다. 무료이고 승인 절차가 없습니다.
 *
 * 토큰이 이 방식의 약점입니다. 액세스 토큰은 여섯 시간이면 만료되므로 리프레시
 * 토큰으로 그때그때 새로 받습니다. 리프레시 토큰 자체는 두 달이고 쓸 때마다
 * 연장되지만, 두 달 넘게 한 번도 안 보내면 만료됩니다 -- 그러면 알림이 조용히
 * 멈춥니다. 실패를 로그에만 남기지 않고 헬스체크에 드러나게 두는 이유입니다.
 *
 * 최초 설정은 사람이 해야 합니다(브라우저 동의). scripts/kakao-authorize.mjs 참고.
 */

const tokenUrl = "https://kauth.kakao.com/oauth/token";
const sendUrl = "https://kapi.kakao.com/v2/api/talk/memo/default/send";

let cachedToken = null;
let cachedUntil = 0;
let lastError = null;

export function kakaoConfigured(config) {
  return Boolean(config.kakao?.restApiKey && config.kakao?.refreshToken);
}

/** 마지막 실패 사유. 헬스체크가 읽습니다 -- 조용히 멈추는 것이 이 경로의 실패 방식입니다. */
export function kakaoLastError() {
  return lastError;
}

async function accessToken(config) {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;

  const body = new URLSearchParams({
    client_id: config.kakao.restApiKey,
    grant_type: "refresh_token",
    refresh_token: config.kakao.refreshToken
  });

  // Client Secret이 켜진 앱은 이것 없이는 KOE010으로 거절합니다.
  if (config.kakao.clientSecret) body.set("client_secret", config.kakao.clientSecret);

  const response = await fetch(tokenUrl, {
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    method: "POST"
  });

  if (!response.ok) throw new Error(`token ${response.status} ${(await response.text()).slice(0, 120)}`);

  const data = await response.json();

  if (!data.access_token) throw new Error("token response carried no access_token");

  cachedToken = data.access_token;
  // 만료 1분 전에 버립니다. 경계에서 한 번 실패하는 것보다 한 번 더 받는 편이 쌉니다.
  cachedUntil = Date.now() + Math.max(60, (data.expires_in ?? 21600) - 60) * 1000;

  // 카카오가 리프레시 토큰을 새로 주는 때가 있습니다. 그때는 .env를 고쳐야 하므로
  // 눈에 띄게 남깁니다 -- 놓치면 두 달 뒤에 조용히 멈춥니다.
  if (data.refresh_token && data.refresh_token !== config.kakao.refreshToken) {
    console.warn(`kakao: 새 리프레시 토큰이 발급됐습니다. .env의 KAKAO_REFRESH_TOKEN을 바꾸세요 → ${data.refresh_token}`);
  }

  return cachedToken;
}

/**
 * 텍스트 한 통. 실패는 던지지 않고 false로 돌려줍니다 -- 알림이 안 갔다고 수집이
 * 멈추면 안 됩니다. 그 시각의 분봉은 다시 못 받지만 알림은 다음 것이 또 옵니다.
 */
export async function sendKakaoMemo(config, { text, url }) {
  if (!kakaoConfigured(config)) return false;

  try {
    const token = await accessToken(config);
    const template = {
      link: url ? { mobile_web_url: url, web_url: url } : {},
      object_type: "text",
      text: text.slice(0, 200)
    };
    const response = await fetch(sendUrl, {
      body: new URLSearchParams({ template_object: JSON.stringify(template) }),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8"
      },
      method: "POST"
    });

    if (!response.ok) throw new Error(`send ${response.status} ${(await response.text()).slice(0, 120)}`);

    lastError = null;

    return true;
  } catch (error) {
    lastError = { at: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) };
    console.warn("kakao: 발송 실패", lastError.message);
    // 토큰이 문제였을 수 있으니 캐시를 버려 다음 시도에 새로 받게 합니다.
    cachedToken = null;

    return false;
  }
}
