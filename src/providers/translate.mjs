import { fetchJson } from "../http.mjs";

/**
 * 영문 한두 문장을 한국어로.
 *
 * 2026-11-01 사용자가 비공식 구글 번역(translate.googleapis.com, client=gtx)을 골랐습니다.
 * 파파고 n2mt가 404로 끝났고 유료 결제는 보류 중입니다. 공식 API가 아니라 언제든 막힐 수
 * 있으므로 **실패하면 null을 돌려주고 부르는 쪽이 원문으로 갑니다** -- 번역 때문에
 * 알림이 안 나가면 안 됩니다.
 *
 * 양이 적은 곳(美 발언 알림, 하루 수십 건)에만 씁니다. 미국 헤드라인 전체처럼 많은 곳에
 * 붙이면 막힐 가능성이 커집니다.
 */
export async function translateToKorean(text, { timeoutMs = 6000 } = {}) {
  const source = String(text ?? "").trim();

  if (!source) return null;
  // 이미 한글이 대부분이면 옮길 것이 없습니다.
  if ((source.match(/[가-힣]/g) ?? []).length > source.length * 0.3) return source;

  try {
    const url = new URL("https://translate.googleapis.com/translate_a/single");

    url.searchParams.set("client", "gtx");
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", source.slice(0, 1500));
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", "ko");

    const data = await fetchJson(url.toString(), { timeoutMs });
    const translated = (data?.[0] ?? []).map((part) => part?.[0] ?? "").join("").trim();

    return translated || null;
  } catch {
    return null;
  }
}

/**
 * 간추리기. 첫 문장부터 maxChars 안에 들어가는 만큼만 남깁니다.
 *
 * 요약 모델이 아니라 앞에서 자르는 것입니다. 발언·성명은 첫 문장에 요지를 두는 경우가
 * 많고(백악관 성명, 연준 연설 제목, 트럼프 글 첫 줄), 항목당 1~2줄이라는 사용자 요청에
 * 맞추려면 이 정도로 충분합니다. 한 문장이 너무 길면 낱말 경계에서 자릅니다.
 */
export function gistOf(text, maxChars = 200) {
  const clean = String(text ?? "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();

  if (clean.length <= maxChars) return clean;

  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [clean];
  let gist = "";

  for (const sentence of sentences) {
    if ((gist + sentence).trim().length > maxChars) break;
    gist += sentence;
  }

  if (gist.trim()) return gist.trim();

  const cut = clean.slice(0, maxChars);

  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), maxChars * 0.6))}…`;
}
