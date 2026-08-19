import { query } from "../db/client.mjs";

/**
 * The themes that actually moved today, for the news search to follow.
 *
 * The news queries are a hand-written list of about eighteen phrases. It covers
 * 반도체 and 2차전지 and 남북경협 because somebody thought of them, and it will
 * never cover 탈모 치료 or 페라이트 or MLCC - the dictionary holds a few hundred
 * themes and the list holds eighteen of them.
 *
 * Asking for all of them every cycle is not the answer either: a few hundred
 * queries every ten minutes against a search API with a quota is how the
 * NewsAPI key was burned in one morning.
 *
 * So it follows the market. The themes carrying real money today are the ones
 * worth a search, and because that set rotates, a theme gets covered on the day
 * it matters rather than never. The collector's own samples are the source, so
 * this costs one query and no external request.
 */

const minimumMembers = 2;
const minimumTurnover = 10_000_000_000;

export async function loadActiveThemes(config, sessionDate, { limit = 12 } = {}) {
  if (!config.databaseUrl) return [];

  const result = await query(config, `
    WITH latest AS (
      SELECT DISTINCT ON (symbol) symbol, theme, change_rate, turnover
      FROM market_price_samples
      WHERE market = 'KR' AND session_date = $1
        AND theme IS NOT NULL AND theme NOT IN ('미분류', 'ETF')
        AND change_rate IS NOT NULL
      ORDER BY symbol, observed_at DESC
    )
    SELECT theme,
           count(*) AS members,
           sum(turnover) AS turnover,
           avg(change_rate) AS average_change
    FROM latest
    GROUP BY theme
    HAVING count(*) >= $2 AND sum(turnover) >= $3
    -- Strength is money first: a theme of two small names up 20% is a pair of
    -- stocks, and a theme the market is buying is a theme the news is about.
    ORDER BY sum(turnover) DESC
    LIMIT $4
  `, [sessionDate, minimumMembers, minimumTurnover, limit]);

  return result.rows.map((row) => ({
    averageChange: Number(row.average_change),
    members: Number(row.members),
    theme: row.theme,
    turnover: Number(row.turnover)
  }));
}

/**
 * The theme name as something a search engine can use.
 *
 * Dictionary names carry qualifiers the news never writes: MLCC·전자부품,
 * 우주태양광(페로브스카이트 등), 원격진료/비대면진료(U-Healthcare). Searched
 * whole they return nothing - measured 0 results for four of six - and searched
 * on the first segment they return the article that was there all along.
 */
export function themeQueryTerm(theme) {
  const trimmed = String(theme).replace(/\([^)]*\)/g, "").split(/[·/]/)[0].trim();

  return `${trimmed || theme} 관련주`;
}
