/**
 * 카카오 리프레시 토큰을 한 번 받아옵니다. 최초 1회만.
 *
 *   node scripts/kakao-authorize.mjs            안내와 동의 URL 출력
 *   node scripts/kakao-authorize.mjs <code>     받은 코드로 토큰 교환
 *
 * 브라우저 동의는 사람이 해야 합니다 -- 본인 계정으로 로그인해 "카카오톡 메시지
 * 전송" 권한을 주는 절차라 자동화할 수 없고, 해서도 안 됩니다.
 *
 * 사전 준비 (developers.kakao.com):
 *   1. 동의항목 → "카카오톡 메시지 전송(talk_message)"을 **선택 동의**로 저장.
 *      기본값인 "사용 안 함"이면 권한 요청 자체가 안 나갑니다.
 *   2. .env에 KAKAO_REST_API_KEY와 KAKAO_CLIENT_SECRET 기록.
 *      사이트 카카오 로그인이 이미 있으면 같은 앱이므로 그 값을 그대로 씁니다.
 *   3. Redirect URI는 로그인용으로 이미 등록된 것을 씁니다.
 *
 * **로그인용 Redirect URI를 쓰면 앱이 코드를 가로챕니다.** 이 프로젝트에서는
 * localhost:3000/auth/kakao/callback이 사이트의 실제 콜백이라, 프론트가 떠 있으면
 * 그쪽이 먼저 받아 로그인으로 처리하고 실패시킵니다(invalid_oauth_state). 그러면
 * 코드는 소비되고 없습니다. 프론트를 잠시 내린 뒤 받으세요 -- 브라우저는 연결
 * 오류를 띄우지만 주소창의 code는 그대로입니다.
 *
 * 워치독도 같이 멈춰야 합니다. 60초마다 프론트를 되살리므로 내려도 다시 뜹니다.
 */

import { readConfig } from "../src/config.mjs";

const config = readConfig();
const key = config.kakao?.restApiKey;
const redirect = process.env.KAKAO_REDIRECT_URI ?? "https://localhost";
const code = process.argv[2];

if (!key) {
  console.log("KAKAO_REST_API_KEY가 .env에 없습니다. developers.kakao.com에서 REST API 키를 받아 넣으세요.");
  process.exit(1);
}

if (!code) {
  const url = `https://kauth.kakao.com/oauth/authorize?client_id=${key}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=talk_message`;

  console.log("\n1) 아래 주소를 브라우저에서 열고 동의하세요.\n");
  console.log(`   ${url}\n`);
  console.log("2) 동의하면 주소창이 다음처럼 바뀝니다. 페이지가 안 열려도 괜찮습니다.\n");
  console.log(`   ${redirect}/?code=XXXXXXXX\n`);
  console.log("3) 그 code 값을 붙여 다시 실행하세요.\n");
  console.log("   node scripts/kakao-authorize.mjs XXXXXXXX\n");
  process.exit(0);
}

const response = await fetch("https://kauth.kakao.com/oauth/token", {
  body: new URLSearchParams({
    client_id: key,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirect,
    // 앱에 Client Secret이 켜져 있으면 필수입니다. 없으면 KOE010입니다.
    ...(config.kakao?.clientSecret ? { client_secret: config.kakao.clientSecret } : {})
  }),
  headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
  method: "POST"
});
const data = await response.json();

if (!response.ok || !data.refresh_token) {
  console.log(`\n실패: ${JSON.stringify(data).slice(0, 300)}\n`);
  console.log("code는 한 번만 쓸 수 있고 몇 분이면 만료됩니다. 1단계부터 다시 하세요.\n");
  process.exit(1);
}

console.log("\n받았습니다. .env에 아래 줄을 넣으세요.\n");
console.log(`KAKAO_REFRESH_TOKEN=${data.refresh_token}\n`);
console.log(`(리프레시 토큰 유효기간 ${Math.round((data.refresh_token_expires_in ?? 0) / 86400)}일 · 쓸 때마다 연장됩니다)\n`);
process.exit(0);
