import { classifyHeadline } from "./overnight-classify.mjs";
import { query } from "../db/client.mjs";

/**
 * 맥락 -- 이 종목을 지목하지 않았지만, 이 종목이 속한 테마를 움직이는 이야기.
 *
 * 2026-09-14 광전자·엑스게이트가 오른 이유는 종목 기사에 없었습니다. 젠슨 황이 광통신과
 * 사이버보안을 말했고(09:22 "젠슨 황 'AI 차세대 시장' 지목에…보안株 강세", 09:31 "AI
 * 데이터센터가 불붙인 광통신株…"), 그 문장이 테마를 지나 종목에 닿았습니다. 사용자가 짚은
 * 대로 이건 종목 기사를 읽어서 알 수 있는 게 아니라 **한 단 위의 이야기를 종목에 이어야**
 * 보이는 종류입니다. 그 연결을 사람이 하려면 그 시각에 그 기사를 보고 있어야 하는데,
 * 우리는 기사와 사전(종목→테마)을 둘 다 갖고 있으니 기계가 이을 수 있습니다.
 *
 * 하는 일은 좁습니다: 종목의 테마 이름에서 낱말을 뽑아, 직전 마감 이후 기사 중 그 낱말이
 * 들어간 것을 찾습니다. 발언·언급·지목·효과처럼 **누가 무엇을 말해서**를 뜻하는 낱말이
 * 있는 기사를 앞에 둡니다. 특징주 자동 기사("X-테마 상승세에 N% ↑")는 뺍니다 -- 오른 것을
 * 다시 쓴 것이라 맥락이 아닙니다.
 *
 * 근거가 아니라 맥락입니다. 상한가 근접·상따 감시의 "지금 들어가나"를 결정하는 자리에는
 * 넣지 않고, 메시지 끝에 따로 표시해 붙입니다. 테마를 데이터로 먼저 찾으려던 시도는 네 번
 * 실패했습니다([[leading-theme-detection]]) -- 여기서도 예측이 아니라 **설명**만 합니다.
 */

const triggerPattern = /발언|언급|지목|쏘아|불붙|효과|정책|발표|공개|출범|추진|허용|승인|투자/;
// 테마 이야기의 얼굴. 종목 하나의 기사가 아니라 묶음을 말하는 낱말입니다.
const themeStoryPattern = /株|관련주|테마|일제히|수혜주|줄줄이|동반|나란히|들썩|불붙|쏘아/;
// 추천·전망·시그널은 이야기가 아니라 광고입니다. 2026-09-14 "MK시그널 추천 후 상승률"이 맥락 자리에 올라왔습니다.
const noisePattern = /추천|시그널|전망\s*\[|주목할|투자분석|리포트|목표가|증권가/;
const autoFeaturePattern = /^특징주,\s|테마 상승세에\s*[\d.]+%/;
const stopWords = new Set(["정보", "기타", "관련", "소재", "부품", "장비", "서비스", "대표주", "생산", "물리", "개발", "산업", "기업"]);

function keywordsOf(themeName) {
  return [...new Set(
    String(themeName)
      .split(/[()\/·,\s]+|\s등$/)
      .map((token) => token.replace(/\s*등$/, "").trim())
      .filter((token) => token.length >= 2 && !stopWords.has(token) && !/^\d+$/.test(token))
  )];
}

export async function loadThemeContext(config, symbol, day, { limit = 2 } = {}) {
  const themes = await query(config,
    "SELECT DISTINCT theme_name FROM kr_theme_membership WHERE symbol = $1", [symbol]);
  const keywordToTheme = new Map();

  for (const row of themes.rows) {
    for (const keyword of keywordsOf(row.theme_name)) {
      if (!keywordToTheme.has(keyword)) keywordToTheme.set(keyword, row.theme_name);
    }
  }

  if (!keywordToTheme.size) return [];

  /*
   * 같은 테마의 다른 회원. 기사가 그중 하나라도 지목했으면 테마 이야기로 칩니다 --
   * "게임"이나 "고령화 사회"처럼 넓은 테마는 낱말만으로는 매일 아무 기사나 걸립니다
   * (위메이드맥스에 "크래프톤 주가 전망"이 올라왔습니다). 낱말 + 회원 지목, 또는
   * 낱말 + 묶음을 말하는 낱말(株·관련주·일제히) 중 하나는 있어야 합니다.
   */
  const members = await query(config, `
    SELECT DISTINCT symbol FROM kr_theme_membership
     WHERE theme_name = ANY($1) AND symbol <> $2`, [[...new Set(themes.rows.map((row) => row.theme_name))], symbol]);
  const memberSet = new Set(members.rows.map((row) => row.symbol));

  const previous = await query(config,
    "SELECT max(session_date)::text AS d FROM kr_daily_universe WHERE session_date < $1::date", [day]);
  const since = previous.rows[0]?.d ? new Date(`${previous.rows[0].d}T15:40:00+09:00`) : new Date(`${day}T00:00:00+09:00`);
  const keywords = [...keywordToTheme.keys()];
  const pattern = keywords.map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  const { rows } = await query(config, `
    SELECT DISTINCT ON (left(regexp_replace(lower(headline), '[^가-힣a-z0-9]', '', 'g'), 30))
           to_char(published_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') AS at,
           headline, original_url, published_at, related_symbols
      FROM market_news_items
     WHERE region = 'KR' AND published_at >= $1 AND published_at < now()
       AND headline ~ $2
       AND NOT ($3 = ANY(coalesce(related_symbols, '{}')))
     ORDER BY left(regexp_replace(lower(headline), '[^가-힣a-z0-9]', '', 'g'), 30), published_at DESC`,
    [since, pattern, symbol]);

  const scored = rows
    .filter((row) => !autoFeaturePattern.test(row.headline) && !noisePattern.test(row.headline))
    .filter((row) => {
      const namesMember = (row.related_symbols ?? []).some((tagged) => memberSet.has(tagged));

      return namesMember || themeStoryPattern.test(row.headline);
    })
    .filter((row) => triggerPattern.test(row.headline) || themeStoryPattern.test(row.headline) || classifyHeadline(row.headline) !== "recap")
    .map((row) => {
      const keyword = keywords.find((candidate) => row.headline.includes(candidate));

      return {
        ...row,
        theme: keyword ? keywordToTheme.get(keyword) : null,
        // 누가 무엇을 말해서(발언·정책)가 먼저, 그다음 묶음 기사, 그다음 최신.
        weight: (triggerPattern.test(row.headline) ? 2 : 0) + (themeStoryPattern.test(row.headline) ? 1 : 0)
      };
    })
    .sort((a, b) => b.weight - a.weight || b.published_at - a.published_at);

  return scored.slice(0, limit);
}

/** 메시지 줄. 근거 줄과 다른 얼굴로 -- 이 종목을 지목한 기사가 아닙니다. */
export function contextLines(context) {
  const lines = [];

  for (const item of context) {
    lines.push(`  맥락 ${item.at}${item.theme ? ` [${item.theme}]` : ""} ${item.headline.slice(0, 70)}`);
    if (item.original_url) lines.push(`       ${item.original_url}`);
  }

  if (context.length) lines.push("  ※ 맥락은 이 종목을 지목한 기사가 아니라 같은 테마를 움직이는 이야기입니다.");

  return lines;
}
