import { sessionDate } from "./market-session.mjs";
import { query } from "../db/client.mjs";

/**
 * The theme dictionary, read from 네이버 금융 rather than from memory.
 *
 * About 280 themes across seven pages, each with a member list. EUC-KR, so the
 * bytes have to be decoded rather than read as text - fetch would hand back
 * mojibake and the symbols would still parse, which is the failure that looks
 * like it worked.
 *
 * Polite by construction: seven index pages plus one detail page per theme,
 * spaced, run at most weekly. Membership moves at the pace of whoever edits it.
 */

const indexUrl = "https://finance.naver.com/sise/theme.naver";
const detailUrl = "https://finance.naver.com/sise/sise_group_detail.naver";
const pageCount = 7;
const requestSpacingMs = 400;
const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readEucKr(url) {
  const response = await fetch(url, { headers: { "User-Agent": browserUserAgent } });

  if (!response.ok) throw new Error(`naver ${response.status} for ${url}`);

  return new TextDecoder("euc-kr").decode(Buffer.from(await response.arrayBuffer()));
}

export async function fetchThemeIndex() {
  const themes = new Map();

  for (let page = 1; page <= pageCount; page += 1) {
    const html = await readEucKr(`${indexUrl}?&page=${page}`);

    for (const match of html.matchAll(/<a href="[^"]*no=(\d+)"[^>]*>([^<]+)<\/a>/g)) {
      const name = match[2].trim();

      if (name) themes.set(Number(match[1]), name);
    }

    await sleep(requestSpacingMs);
  }

  return themes;
}

export async function fetchThemeMembers(themeNo) {
  const html = await readEucKr(`${detailUrl}?type=theme&no=${themeNo}`);
  const members = new Map();

  for (const match of html.matchAll(/\/item\/main\.naver\?code=(\w{6})"[^>]*>([^<]+)</g)) {
    if (!members.has(match[1])) members.set(match[1], match[2].trim());
  }

  return members;
}

export async function saveThemeMembers(config, themeNo, themeName, members) {
  if (members.size === 0) return 0;

  const symbols = [...members.keys()];
  const result = await query(config, `
    INSERT INTO kr_theme_members (theme_no, theme_name, symbol, name)
    SELECT $1, $2, symbol, name
    FROM unnest($3::text[], $4::text[]) AS t(symbol, name)
    ON CONFLICT (theme_no, symbol) DO UPDATE
      SET theme_name = EXCLUDED.theme_name, name = EXCLUDED.name, fetched_at = now()
  `, [themeNo, themeName, symbols, symbols.map((symbol) => members.get(symbol))]);

  return result.rowCount;
}

/**
 * One theme per symbol: the oldest of the ones that actually rose today.
 *
 * 70% of the 2,394 symbols here sit in more than one theme and the board has a
 * single slot, so the choice matters more than the membership does.
 *
 * This used to take the narrowest, reasoning that a theme with nine members
 * says more than one with two hundred. Measured against the curated map — 152
 * symbols that are in it and carry several themes here — narrowest agreed 31%
 * of the time, and the failures all read the same way:
 *
 *   심텍          소캠(SOCAMM)        vs  PCB(FPCB 등)
 *   HPSP         온디바이스 AI          vs  반도체 장비
 *   아난티         호텔/리조트           vs  남북경협
 *   유진로봇        DMZ 평화공원          vs  지능형로봇/인공지능(AI)
 *   코미코         태양광에너지           vs  반도체 장비
 *
 * The narrow theme is almost always the newest one — whatever the market was
 * excited about the month it was created — and the old one is the business.
 * Naver numbers themes in the order it makes them, so the number is an age, and
 * ordering by age alone lifts agreement to 48%.
 *
 * Age by itself loses the day, though. 우리기술투자 came out 창투사 and
 * 파라택시스이더리움 came out 보안주(정보) on 2026-08-21 — the day bitcoin ran
 * 21% and both of them limit-up — because 가상화폐(비트코인 등) is a newer theme
 * than either. The label was right about the business and useless about the
 * session, and a theme nobody is trading cannot group a 강세 테마 panel.
 *
 * So the themes that rose today go first, and age decides among them: both coin
 * names come back 가상화폐(비트코인 등) while 코미코 stays 반도체 장비, because
 * none of 코미코's themes were up and the rule falls back to age. Measured 49%,
 * the best of everything tried — greedily taking the day's strongest theme
 * instead scored 27%, since on a red day it just picks the least bad noise.
 *
 * No membership is lost either way. Every theme a symbol belongs to stays in
 * kr_theme_members, and only the one label shown is a simplification.
 */

/**
 * Themes that describe a listing rather than a business.
 *
 * These are the ones age would otherwise hand the win to: 지주사 is number 111
 * and holds 127 companies, so under an oldest-first rule every holding company
 * in the market would be labelled by its corporate structure. None of them is a
 * reason a stock moved, and 코스맥스 came out 밸류업 over 화장품 back when the
 * rule was narrowness — so they have to be excluded rather than ranked.
 */
const nonBusinessThemePattern = "(밸류업|기업인수목적|신규상장|리츠\\(REITs\\)|국내 상장 중국기업|지주사)";

// A theme needs a few members priced today before its average means anything.
/*
 * 테마 하나를 "움직였다"고 부르려면 몇 종목이 있어야 하는가.
 *
 * 3이었습니다. 그러면 세 종목짜리 좁은 테마가 평균이 크게 흔들려 늘 이깁니다 --
 * 2026-08-25에 이노메트리가 "유리 기판", 엑시콘이 "CXL"을 달았습니다. 틀린 건
 * 아니지만 그날 그 종목이 오른 이유는 아닙니다.
 *
 * 8입니다. 15로 올리면 반도체 라벨은 더 나아지는 대신 "가상화폐"(그날 표본 12종목)가
 * 잘려 비트플래닛이 "클라우드 컴퓨팅"으로 갑니다 -- 고치려던 바로 그 문제입니다.
 */
const minimumThemeSample = 8;

export async function loadSymbolThemes(config) {
  if (!config.databaseUrl) return new Map();

  const result = await query(config, `
    WITH business AS (
      SELECT symbol, theme_name, theme_no
        FROM kr_theme_members
       WHERE theme_name !~ $1
    ),
    -- 전 종목 일봉이라 테마의 모든 회원이 들어옵니다. 순위권만 보면 오른 종목만
    -- 세게 되어 어느 테마든 올라 보입니다.
    --
    -- **날짜가 문제였습니다.** kr_daily_universe는 전 종목 훑기(15:50)로 하루에
    -- 한 번만 쌓이므로, 장중에 이걸 읽으면 "오늘 오른 테마"가 실제로는 **어제 오른
    -- 테마**입니다. 2026-08-25에 현대건설이 원전으로 9% 오르는 동안 화면은 어제
    -- 기준으로 테마파크를 달고 있었습니다 -- 어제 테마파크가 +0.68%로 오른 테마
    -- 중 가장 오래된 것이었기 때문입니다.
    --
    -- 오늘 장이 열려 분봉이 쌓였으면 그쪽을 먼저 봅니다. 분봉 모집단은 거래대금
    -- 순위라 오른 종목으로 기우니, 절대 상승이 아니라 **그 표본 안의 시장 평균 대비
    -- 초과**로 판정합니다. 그러면 다 같이 오른 날 모든 테마가 통과하는 일이 없습니다.
    live AS (
      SELECT DISTINCT ON (symbol) symbol, change_rate AS move
        FROM market_price_samples
       WHERE market = 'KR' AND session_date = $3::date
         AND source LIKE 'kis:krx%' AND change_rate IS NOT NULL
       ORDER BY symbol, observed_at DESC
    ),
    live_base AS (SELECT avg(move) AS market FROM live),
    live_theme AS (
      SELECT b.theme_name, avg(l.move) - (SELECT market FROM live_base) AS theme_move
        FROM business b
        JOIN live l ON l.symbol = b.symbol
       GROUP BY b.theme_name
      HAVING count(*) >= $2
    ),
    -- 개장 전과 주말에는 분봉이 없습니다. 그때만 마지막 일봉 스냅샷으로 답합니다.
    snapshot AS (
      SELECT b.theme_name, avg(u.change_rate) AS theme_move
        FROM business b
        JOIN kr_daily_universe u
          ON u.symbol = b.symbol
         AND u.session_date = (SELECT max(session_date) FROM kr_daily_universe)
       GROUP BY b.theme_name
      HAVING count(*) >= $2
    ),
    session AS (
      SELECT theme_name, theme_move FROM live_theme
       UNION ALL
      SELECT theme_name, theme_move FROM snapshot
       WHERE NOT EXISTS (SELECT 1 FROM live_theme)
    )
    SELECT DISTINCT ON (b.symbol) b.symbol, b.theme_name
      FROM business b
      LEFT JOIN session s ON s.theme_name = b.theme_name
     -- 오른 테마 중에서 **가장 크게** 오른 것입니다.
     --
     -- theme_no ASC였습니다. 조금이라도 오르기만 하면 번호가 작은 테마가 이기는
     -- 규칙이라, 상장이 오래된 테마가 늘 이깁니다. 2026-08-25에 아이티센글로벌과
     -- 비트플래닛이 "SI(시스템통합)"(no.17)를 달고 한 카드에 묶였습니다. 그날 SI는
     -- -0.58%p로 두 종목의 테마 중 **가장 나빴고**, 비트플래닛을 상한가로 민 것은
     -- 가상화폐(+5.07%p)였습니다. 테마의 나이는 신호가 아닙니다.
     --
     -- theme_no는 마지막 동점 처리로만 남깁니다 -- 값이 같을 때 순서가 흔들리면
     -- 새로고침마다 라벨이 바뀝니다.
     ORDER BY b.symbol,
              (CASE WHEN coalesce(s.theme_move, 0) > 0 THEN 0 ELSE 1 END),
              s.theme_move DESC NULLS LAST,
              b.theme_no ASC
  `, [nonBusinessThemePattern, minimumThemeSample, sessionDate("KR")]);

  const ranked = new Map(result.rows.map((row) => [row.symbol, row.theme_name]));
  // 오늘 기사가 테마를 지목하면 그쪽이 이깁니다. 순위 규칙은 무엇이 올랐는지만
  // 알고 왜 올랐는지는 모릅니다.
  const fromNews = await loadNewsThemes(config).catch(() => new Map());

  for (const [symbol, theme] of fromNews) ranked.set(symbol, theme);

  return ranked;
}

export async function refreshThemes(config, { log = () => {} } = {}) {
  const index = await fetchThemeIndex();

  log(`naver themes · ${index.size} themes`);

  let saved = 0;

  for (const [themeNo, themeName] of index) {
    try {
      const members = await fetchThemeMembers(themeNo);

      saved += await saveThemeMembers(config, themeNo, themeName, members);
    } catch (error) {
      // One theme that will not load is not a reason to abandon the other 279.
      log(`naver themes · ${themeName} failed: ${error instanceof Error ? error.message : error}`);
    }

    await sleep(requestSpacingMs);
  }

  return { saved, themes: index.size };
}

/**
 * 오늘 기사가 그 종목의 테마를 직접 말하는가.
 *
 * 순위 규칙(오른 것 중 오래된 것)은 **왜 올랐는지**를 모릅니다. 차트와 테마
 * 평균만 보기 때문입니다. 2026-08-25에 현대건설이 미국 원전 수주 기대로 9%
 * 올랐을 때 규칙은 `건설 대표주`를, 한전기술에는 `풍력에너지`를 달았습니다.
 * 순서를 바꿔 봐도 나아지지 않습니다 -- 가장 많이 오른 테마를 집으면 한화가
 * `태양광에너지`가 됩니다. 예전 측정도 같은 결론이었습니다(가장 오른 테마 27%,
 * 오른 것 중 오래된 것 49%).
 *
 * 뉴스는 압니다. 같은 날 기사가 "하반기 미국 원전 확대에 따른 추가 수주 가능성"
 * 이라고 적혀 있습니다. 그래서 기사가 테마를 지목하면 그것을 쓰고, 아니면 기존
 * 규칙으로 돌아갑니다.
 *
 * 순환을 피하는 두 가지:
 *
 *   회사 이름을 지우고 봅니다. 현대**건설** 기사가 `건설 대표주`를 보증하는 것은
 *   근거가 아니라 이름의 반복입니다.
 *
 *   태그가 **정확히 그 심볼**인 기사만 씁니다. 한화 기사 46건에는 한화투자증권
 *   기사가 섞입니다.
 */

// 기사는 줄여 씁니다. 테마명이 그대로 나오는 일은 드뭅니다.
const themeAliases = {
  "2차전지": ["배터리"],
  "방위산업/전쟁 및 테러": ["방산"],
  "원자력발전": ["원전"],
  "원자력발전소 해체": ["원전 해체", "원전해체"]
};

// 한 건은 우연일 수 있습니다. 두 건이면 그 기사가 그 종목을 그 테마로 부르고
// 있다고 봅니다.
const minimumThemeArticles = 2;

function themeKeywords(theme) {
  const base = theme.replace(/\(.*?\)/g, "").trim();
  const words = base.split(/[\s·/]+/).filter((word) => word.length >= 2);

  return [...new Set([theme, base, ...words, ...(themeAliases[theme] ?? [])])];
}

export async function loadNewsThemes(config, { day = sessionDate("KR") } = {}) {
  if (!config.databaseUrl) return new Map();

  const [{ rows: news }, { rows: members }, { rows: names }] = await Promise.all([
    query(config, `
      SELECT headline, related_symbols FROM market_news_items
       WHERE region = 'KR' AND related_symbols IS NOT NULL
         AND array_length(related_symbols, 1) > 0
         AND (published_at + interval '9 hours')::date = $1::date
    `, [day]),
    query(config, `SELECT symbol, theme_name FROM kr_theme_members WHERE theme_name !~ $1`, [nonBusinessThemePattern]),
    query(config, `
      SELECT symbol, name FROM kr_daily_universe
       WHERE session_date = (SELECT max(session_date) FROM kr_daily_universe) AND length(name) >= 2
    `)
  ]);

  if (news.length === 0) return new Map();

  const nameOf = new Map(names.map((row) => [row.symbol, row.name]));
  const byStock = new Map();

  news.forEach((item) => {
    item.related_symbols.forEach((symbol) => {
      if (!byStock.has(symbol)) byStock.set(symbol, []);
      byStock.get(symbol).push(item.headline);
    });
  });

  const themesOf = new Map();

  members.forEach((row) => {
    if (!themesOf.has(row.symbol)) themesOf.set(row.symbol, []);
    themesOf.get(row.symbol).push(row.theme_name);
  });

  const picked = new Map();

  for (const [symbol, headlines] of byStock) {
    const themes = themesOf.get(symbol);

    if (!themes) continue;

    const own = nameOf.get(symbol);
    const texts = own ? headlines.map((line) => line.split(own).join(" ")) : headlines;
    const best = themes
      .map((theme) => {
        const keys = themeKeywords(theme);

        return { hits: texts.filter((text) => keys.some((key) => text.includes(key))).length, theme };
      })
      .filter((entry) => entry.hits >= minimumThemeArticles)
      .sort((left, right) => right.hits - left.hits)[0];

    if (best) picked.set(symbol, best.theme);
  }

  return picked;
}
