/**
 * 한 종목을 부르는 다른 이름 -- 지금은 영문 상호.
 *
 * 2026-09-10 에스투더블유(488280)가 오픈AI '데이브레이크' 합류로 +11.9% 마감했는데
 * `[재료]` 알림이 한 통도 안 나갔습니다. 기사 여섯 건 중 다섯 건이 제목을 **S2W**로
 * 썼고, 우리 태깅은 한글 상호만 찾기 때문입니다. 한 건 붙은 것은 "에스투더블유"로
 * 쓴 아이뉴스24뿐이었습니다. 영문으로만 불리는 종목은 재료가 있어도 없는 것과
 * 같았습니다.
 *
 * 출처는 DART corpCode의 `corp_eng_name`입니다 -- 상장 3,990종목 중 3,987종목에
 * 있습니다. 법인 접미사(Inc., Co., Ltd. …)는 기사가 쓰지 않으므로 떼어냅니다.
 *
 * **짧고 흔한 영단어는 별칭이 될 수 없습니다.** "S2W"는 안전하지만 "GREEN"이나
 * "FIRST"는 아무 기사에나 붙습니다. 그래서 걸러내는 규칙을 두 겹으로 둡니다.
 *
 *   1. 여기: 모양으로 거르기 -- 길이, 숫자 포함, 낱말 수
 *   2. `scripts/backfill-kr-aliases.mjs`: 실제 코퍼스에서 몇 건에 걸리는지 세어,
 *      너무 흔한 것은 저장하지 않기
 *
 * 모양만으로는 "흔한가"를 알 수 없고, 빈도만으로는 "우연히 안 나온 것"과
 * "안전한 것"을 못 가릅니다. 둘 다 통과해야 별칭이 됩니다.
 */

// 기사 제목에 쓰이지 않는 법인격 표기. 뒤에서부터 반복해 떼어냅니다 --
// "CO.,LTD."는 두 번, "Inc."는 한 번입니다.
const legalSuffixes = [
  "co ltd", "co.,ltd", "corporation", "incorporated", "holdings co", "company",
  "limited", "corp", "inc", "ltd", "co", "plc", "llc", "kg", "ag", "sa"
];

// 한 낱말짜리 별칭이 이 목록에 있으면 버립니다. 영문 상호가 통째로 평범한
// 명사인 경우이고, 빈도 측정 전에 미리 걸러 두면 측정 결과가 읽기 쉬워집니다.
const commonWords = new Set([
  "first", "green", "global", "korea", "life", "next", "one", "power", "prime",
  "smart", "star", "sun", "top", "union", "value", "world", "young", "best",
  "future", "good", "high", "home", "king", "master", "new", "open", "plus",
  "point", "pure", "real", "sky", "soft", "solution", "solutions", "space",
  "system", "systems", "tech", "technology", "trust", "up", "win"
]);

/**
 * 영문 상호에서 기사가 실제로 쓰는 이름만 남깁니다.
 *
 * "S2W Inc." → "S2W", "SEMPIO FOODS COMPANY" → "SEMPIO FOODS",
 * "SAMSUNG ELECTRONICS CO,.LTD" → "SAMSUNG ELECTRONICS".
 *
 * 별칭이 될 수 없으면 null입니다.
 */
export function aliasFromEnglishName(englishName) {
  if (!englishName) return null;

  // 구두점을 공백으로 바꾸고 낱말로 다룹니다. `CO,.LTD`처럼 마침표와 쉼표가
  // 뒤섞인 표기가 흔해서, 구두점을 살려 두면 접미사 목록이 끝없이 늘어납니다.
  let words = String(englishName)
    .replace(/[.,()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  for (let cut = true; cut && words.length > 1;) {
    cut = false;

    for (const suffix of legalSuffixes) {
      const parts = suffix.split(" ");
      const tail = words.slice(-parts.length).join(" ").toLowerCase();

      if (words.length > parts.length && tail === suffix) {
        words = words.slice(0, -parts.length);
        cut = true;
        break;
      }
    }
  }

  const alias = words.join(" ").trim();

  if (!isUsableAlias(alias)) return null;

  return alias;
}

/**
 * 모양으로 거르기.
 *
 * 두 글자는 무조건 버립니다 -- 'LS', 'SK', 'GS'는 한글 상호가 이미 그 두 글자라
 * 별칭이 필요 없고, 그 밖의 두 글자는 본문 어디에나 걸립니다.
 */
function isUsableAlias(alias) {
  if (!alias || alias.length < 3) return false;
  // 라틴 글자로만 이뤄져야 합니다. 한글이 섞여 있으면 그건 이미 한글 이름 쪽에서
  // 찾고 있고, 다른 문자는 기사 표기와 맞을 일이 없습니다.
  if (!/^[A-Za-z0-9&\- ]+$/.test(alias)) return false;
  // 숫자만이거나 숫자로 시작하면 연도·수량과 구별되지 않습니다.
  if (/^[0-9]/.test(alias)) return false;

  const words = alias.split(" ");

  // 두 낱말 이상이면 우연히 겹칠 일이 거의 없습니다.
  if (words.length > 1) return true;
  // 한 낱말이면 숫자가 섞여 있거나(S2W, K2), 흔한 영단어가 아니어야 합니다.
  if (/[0-9]/.test(alias)) return true;

  return !commonWords.has(alias.toLowerCase()) && alias.length >= 4;
}

/**
 * 별칭이 **이 회사를 가리키며** 등장하는가.
 *
 * 낱말 경계만으로는 모자랍니다. 국내 매체가 번역해 싣는 미국 기사가 같은 코퍼스에
 * 있어서, 2026-09-11 실측으로 이런 것들이 걸렸습니다:
 *
 *   "NANO Nuclear Energy(NNE)의 마이크로 원자로"   → 나노(187790)
 *   "Mercury Systems EVP, 주식 338,030달러 매도"   → 머큐리(100590)
 *   "Hims & Hers Has Fallen 56% From Its High"     → 힘스(238490)
 *
 * 셋 다 별칭 **뒤에 영문 낱말이 이어집니다.** 그게 다른 회사의 이름이라는 뜻입니다.
 * 한글 기사가 우리 종목을 부를 때는 "S2W, 오픈AI…"나 "SOOP, 189억원…"처럼 뒤가
 * 한글이거나 구두점입니다.
 *
 * 그래서 앞뒤에 영문 낱말이 붙어 있으면 버립니다. "NAVER Cloud"처럼 정당한 표기도
 * 같이 버려지지만, 놓치는 쪽이 엉뚱한 종목에 재료를 붙이는 것보다 낫습니다 --
 * 그 재료는 알림으로 나가고 종가배팅 후보의 근거로 화면에 오릅니다.
 */
export function aliasAppears(text, alias) {
  const haystack = String(text).toLowerCase();
  const needle = String(alias).toLowerCase();

  for (let from = 0;;) {
    const at = haystack.indexOf(needle, from);

    if (at < 0) return false;

    if (!latinNeighbour(haystack, at - 1, -1) && !latinNeighbour(haystack, at + needle.length, 1)) return true;

    from = at + 1;
  }
}

/** 그 방향으로 공백을 건너뛴 첫 글자가 영문 낱말의 일부인가. */
function latinNeighbour(text, from, step) {
  for (let at = from; at >= 0 && at < text.length; at += step) {
    const char = text[at];

    if (char === " ") continue;
    // 앰퍼샌드는 영문 상호를 잇는 기호입니다 -- "Hims & Hers".
    return /[a-z0-9&]/.test(char);
  }

  return false;
}
