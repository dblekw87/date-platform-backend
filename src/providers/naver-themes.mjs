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
 * One theme per symbol, chosen as the narrowest one it belongs to.
 *
 * A stock sits in several of these - 한국전력 is in 남북경협 and in half a dozen
 * power themes - and the board has one slot. Narrowest wins because a theme with
 * nine members says more about why a stock moved than one with two hundred: the
 * broad ones are sectors wearing a theme's name, and the point of this table is
 * the groups a sector cannot express.
 *
 * Ties break on the lower theme number, which is the older theme, so the answer
 * does not move around between loads.
 *
 * It is wrong when a stock carries a small legacy line: 브이티 sells cosmetics
 * and sits in 2차전지(LFP) at 12 members against 화장품 at 93, so narrowness
 * picks the battery. Nothing in the membership distinguishes a main business
 * from a leftover one, and guessing from size alone cannot. That is what the
 * curated map above it is for, and no membership is lost either way - every
 * theme a symbol belongs to stays in kr_theme_members, and only the one label
 * shown is a simplification.
 */
export async function loadSymbolThemes(config) {
  if (!config.databaseUrl) return new Map();

  // 밸류업 is index membership, not a reason a stock moved. It is also small
  // enough to win on narrowness - 코스맥스 came out 밸류업 at 84 members over
  // 화장품 at 93 - so it has to be excluded rather than ranked.
  const result = await query(config, `
    SELECT DISTINCT ON (m.symbol) m.symbol, m.theme_name
    FROM kr_theme_members m
    JOIN (
      SELECT theme_no, count(*) AS members FROM kr_theme_members GROUP BY theme_no
    ) size ON size.theme_no = m.theme_no
    WHERE m.theme_name NOT LIKE '%밸류업%'
    ORDER BY m.symbol, size.members ASC, m.theme_no ASC
  `);

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
