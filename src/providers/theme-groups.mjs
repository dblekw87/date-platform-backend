import { formatTradingAmount } from "./format.mjs";
import { query } from "../db/client.mjs";

/**
 * 짝꿍 candidates for the themes the leader board never reaches.
 *
 * buildPairBoard works off the day's ranked leaders, so it can only ever offer
 * a theme that put someone in the turnover top - four of them on 2026-08-19.
 * Every other theme that moved that day was invisible, which is the same
 * keyhole the collector had: what is ranked is a small slice of what is moving.
 *
 * The collector already samples every symbol it has seen once, ranked or not,
 * so the wider picture is sitting in market_price_samples. This reads the most
 * recent tick out of it and groups by theme - no additional request, and it
 * covers the 446 symbols the day actually touched rather than the 38 in the
 * ranking.
 *
 * Shaped exactly like buildPairBoard's rows so the board renders both with one
 * component. The leader is the theme's highest turnover, and the followers are
 * ordered by how little they have moved, which is the order the trade is read
 * in.
 */

const minimumMembers = 2;
const maximumThemes = 12;
const maximumCandidates = 8;

export async function loadThemeGroups(config, sessionDate, { exclude = [] } = {}) {
  if (!config.databaseUrl) return [];

  const excluded = new Set(exclude);
  // The newest observation per symbol, which is the board's "now". Themes are
  // grouped from that rather than from the whole day, so a name that led at
  // 09:10 and faded does not still read as the theme's leader at 15:00.
  const result = await query(config, `
    SELECT DISTINCT ON (symbol) symbol, name, theme, change_rate, turnover, market_cap
    FROM market_price_samples
    WHERE session_date = $1 AND market = 'KR'
      AND theme IS NOT NULL AND theme NOT IN ('미분류', 'ETF')
      AND change_rate IS NOT NULL
    ORDER BY symbol, observed_at DESC
  `, [sessionDate]);
  const byTheme = new Map();

  for (const row of result.rows) {
    if (excluded.has(row.theme)) continue;

    if (!byTheme.has(row.theme)) byTheme.set(row.theme, []);

    byTheme.get(row.theme).push(row);
  }

  const groups = [];

  for (const [theme, rows] of byTheme) {
    if (rows.length < minimumMembers) continue;

    const byTurnover = [...rows].sort((left, right) => Number(right.turnover ?? 0) - Number(left.turnover ?? 0));
    const leader = byTurnover[0];
    const followers = byTurnover.slice(1)
      .sort((left, right) => Number(left.change_rate) - Number(right.change_rate))
      .slice(0, maximumCandidates);

    if (followers.length === 0) continue;

    groups.push({
      candidates: followers.map((row) => ({
        changeRateValue: Number(row.change_rate),
        inLeaderBoard: false,
        name: row.name ?? row.symbol,
        symbol: row.symbol,
        turnover: formatTradingAmount(Number(row.turnover ?? 0), "KRW")
      })),
      id: `theme-group-kr-${theme}`,
      leader: {
        changeRateValue: Number(leader.change_rate),
        name: leader.name ?? leader.symbol,
        symbol: leader.symbol,
        turnover: formatTradingAmount(Number(leader.turnover ?? 0), "KRW")
      },
      // Same reading as the pair board: how far the least-moved member still is
      // from the one the money is in.
      leadGap: Number((Number(leader.change_rate) - Number(followers[0].change_rate)).toFixed(2)),
      market: "KR",
      theme
    });
  }

  return groups
    .sort((left, right) => right.leadGap - left.leadGap)
    .slice(0, maximumThemes);
}
