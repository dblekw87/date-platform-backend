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
const minimumThemeSample = 3;

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
    session AS (
      SELECT b.theme_name, avg(u.change_rate) AS theme_move
        FROM business b
        JOIN kr_daily_universe u
          ON u.symbol = b.symbol
         AND u.session_date = (SELECT max(session_date) FROM kr_daily_universe)
       GROUP BY b.theme_name
      HAVING count(*) >= $2
    )
    SELECT DISTINCT ON (b.symbol) b.symbol, b.theme_name
      FROM business b
      LEFT JOIN session s ON s.theme_name = b.theme_name
     ORDER BY b.symbol,
              (CASE WHEN coalesce(s.theme_move, 0) > 0 THEN 0 ELSE 1 END),
              b.theme_no ASC
  `, [nonBusinessThemePattern, minimumThemeSample]);

  return new Map(result.rows.map((row) => [row.symbol, row.theme_name]));
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
