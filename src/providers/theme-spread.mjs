import { query } from "../db/client.mjs";

/**
 * 재료 알림에 "같은 테마의 다른 종목" 한 줄을 붙입니다.
 *
 * 2026-11-26 05:00 "[다음 장 후보] 한화시스템·한국항공우주 C"가 나갔습니다 -- 근거는
 * "스페이스X 위성 100만기 승인…한국항공우주·한화시스템 우주산업 날개". 기사가 대형주
 * 둘을 불렀고 알림도 그 둘만 적었는데, 그날 실제로 뛴 건 미래에셋벤처투자 +21·나라스페이스
 * +17·스피어 +15·AP위성 +10이었고 한화시스템은 +4.3이었습니다. 사용자: "우주 말고도 그런
 * 전체 테마를 가리킬 수 있는 것들도 텔레그램으로 쏴 줘야 돼."
 *
 * **테마는 이름으로 추정하지 않습니다**(memory theme-dictionary-lag). 알림 종목이 실제로
 * 속한 네이버 테마 중에서 **기사 제목이 그 테마를 가리키는 것**만 씁니다: 테마 이름의 낱말이
 * 제목에 나오거나, 제목의 낱말이 테마 이름 안에 들어 있을 때(위성 ⊂ 인공위성). 한화시스템은
 * 방산·드론·UAM·우주항공 등 여덟 테마에 들어 있는데, 이 제목에선 우주항공만 걸립니다.
 * 아무 테마도 안 걸리면 줄을 붙이지 않습니다 -- 틀린 테마를 붙이느니 없는 게 낫습니다.
 *
 * 순서는 직전 장 거래대금입니다. 밤에는 그 외에 돈의 크기를 잴 값이 없습니다.
 */

const memberLimit = 6;
/* 테마 이름에 흔히 붙는 꼬리. 이게 맞았다고 테마를 가리킨 건 아닙니다. */
const genericTokens = new Set(["관련주", "테마", "산업", "관련", "기타", "국내", "해외", "기업", "지수"]);
/* 기사 제목에 흔한 동사·수식어. 테마 이름 안에 들어 있어도(신규상장 ⊃ 신규) 테마를 가리킨 게 아닙니다
   (11/26 시험: "신규 표적 ADC 과제 선정" → '2026 하반기 신규상장'). */
const headlineNoise = new Set(["신규", "추가", "승인", "선정", "계약", "확대", "개발", "기대", "강세", "급등", "수혜", "추진", "대표", "하반기", "상반기", "글로벌", "시장", "사업", "기술", "공급", "투자", "목표가", "주가",
  // 그룹 이름. "삼성證"의 '삼성'이 'S7(삼성전자/SK하이닉스 등)'을 가리킨 게 아닙니다.
  "삼성", "현대", "LG", "SK", "한화", "롯데", "포스코", "두산", "CJ", "GS", "HD", "카카오", "네이버", "효성", "코오롱"]);

function words(text) {
  return String(text ?? "")
    .split(/[^0-9A-Za-z가-힣]+/)
    .filter((word) => word.length >= 2 && !/^\d+$/.test(word));
}

/** 제목이 이 테마를 가리키는가. 맞은 낱말 수를 돌려줍니다(0이면 아님). */
export function themeHits(themeName, headline, excluded = []) {
  // 종목 이름은 지웁니다. "한미반도체"가 제목에 있다고 '반도체' 테마를 가리킨 건 아닙니다.
  const text = [...excluded].filter(Boolean).sort((a, b) => b.length - a.length)
    .reduce((rest, name) => rest.split(name).join(" "), String(headline ?? ""));
  const themeWords = words(themeName).filter((word) => !genericTokens.has(word));
  const headlineWords = words(text).filter((word) => !genericTokens.has(word) && !headlineNoise.has(word));
  let hits = 0;

  for (const token of themeWords) {
    if (text.includes(token) || headlineWords.some((word) => token.includes(word))) hits += 1;
  }

  return hits;
}

/**
 * picks: [{ symbol, listing: { name }, material: [{ headline }] }]
 * 각 pick에 spread = { theme, members: [{ symbol, name, turnover, change_rate }] } 를 붙입니다.
 */
export async function attachThemeSpread(config, picks, day) {
  if (!picks.length) return picks;

  const symbols = picks.map((pick) => pick.symbol);
  const { rows: memberships } = await query(config, `
    SELECT symbol, theme_name FROM kr_theme_members WHERE symbol = ANY($1)`, [symbols]);
  const themesOf = new Map();

  for (const row of memberships) {
    if (!themesOf.has(row.symbol)) themesOf.set(row.symbol, []);
    themesOf.get(row.symbol).push(row.theme_name);
  }

  const names = picks.map((pick) => pick.listing?.name).filter(Boolean);
  const chosen = new Map();

  for (const pick of picks) {
    // 뉴스 제목만 봅니다. 공시 제목은 보고서 이름이라("타법인주식및출자증권취득결정") 테마를 가리키지 않습니다.
    const headlines = (pick.material ?? []).map((item) => item.headline).join(" ");
    const scored = (themesOf.get(pick.symbol) ?? [])
      .map((theme) => ({ hits: themeHits(theme, headlines, names), theme }))
      .filter((item) => item.hits > 0)
      .sort((a, b) => b.hits - a.hits || a.theme.localeCompare(b.theme));

    if (scored.length) chosen.set(pick, scored[0].theme);
  }

  const themes = [...new Set(chosen.values())];

  if (!themes.length) return picks;

  const { rows } = await query(config, `
    SELECT m.theme_name, u.symbol, u.name, u.turnover::float8 AS turnover, u.change_rate::float8 AS change_rate
      FROM kr_theme_members m
      JOIN kr_daily_universe u ON u.symbol = m.symbol
       AND u.session_date = (SELECT max(session_date) FROM kr_daily_universe WHERE session_date <= $2::date)
     WHERE m.theme_name = ANY($1) AND NOT (u.symbol = ANY($3)) AND coalesce(u.trade_halted, false) = false
     ORDER BY u.turnover DESC NULLS LAST`, [themes, day, symbols]);
  const byTheme = new Map();

  for (const row of rows) {
    if (!byTheme.has(row.theme_name)) byTheme.set(row.theme_name, []);
    if (byTheme.get(row.theme_name).length < memberLimit) byTheme.get(row.theme_name).push(row);
  }

  for (const pick of picks) {
    const theme = chosen.get(pick);

    if (theme && byTheme.get(theme)?.length) pick.spread = { members: byTheme.get(theme), theme };
  }

  return picks;
}

/** 알림 한 줄. 같은 테마는 한 통에 한 번만 적도록 printed를 받습니다. */
export function spreadLine(pick, printed = new Set()) {
  if (!pick.spread || printed.has(pick.spread.theme)) return null;

  printed.add(pick.spread.theme);

  const members = pick.spread.members
    .map((row) => `${row.name} ${Math.round((row.turnover ?? 0) / 1e8)}억`)
    .join(" · ");

  return `  같은 테마(${pick.spread.theme}): ${members} — 직전 장 거래대금 순`;
}
