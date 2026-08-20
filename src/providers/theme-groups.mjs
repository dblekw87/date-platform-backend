import { formatTradingAmount } from "./format.mjs";
import { isPreferredShare, minimumCandidateTurnover } from "./pairing.mjs";
import { query } from "../db/client.mjs";

/**
 * 짝꿍 candidates read out of the record, one panel per trading session.
 *
 * buildPairBoard works off whatever the leader board is showing right now, so
 * it cannot answer "what was pairable in the regular session" once the regular
 * session is over, and it has nothing at all to say about the NXT evening. Both
 * are in market_price_samples, which the collector fills for every symbol it
 * has seen rather than only the ranked ones.
 *
 * The two windows are kept apart because they are different books with
 * different liquidity, and a pair that held at 14:00 on KRX says nothing about
 * the same two names at 18:00 on NXT.
 *
 *   regular  09:00-15:30 KRX. The KRX book stops updating after 15:30, so
 *            anything later is the closing auction repeating itself.
 *   after    15:40-20:00 NXT, which is the session the evening panel is about.
 *
 * Only the newest tick inside the window counts, so a pair whose condition has
 * since broken - the leader no longer up, the follower no longer following -
 * drops out on its own rather than lingering as a stale row.
 *
 * Shaped exactly like buildPairBoard's rows so one component renders both.
 */

const windows = {
  after: { from: "15:40", source: "kis:nxt:after", to: "20:00" },
  regular: { from: "09:00", source: "kis:krx%", to: "15:30" }
};

const minimumMembers = 2;
const maximumThemes = 12;
const maximumCandidates = 8;

export async function loadThemeGroups(config, sessionDate, { exclude = [], window = "regular" } = {}) {
  if (!config.databaseUrl) return [];

  const excluded = new Set(exclude);
  const bounds = windows[window] ?? windows.regular;
  // The newest observation per symbol, which is the board's "now". Themes are
  // grouped from that rather than from the whole day, so a name that led at
  // 09:10 and faded does not still read as the theme's leader at 15:00.
  const result = await query(config, `
    -- name <> symbol first, so a row the sweep could not name never becomes
    -- the label. A theme whose leader reads "950260" is a theme nobody can read.
    SELECT DISTINCT ON (symbol) symbol,
           coalesce(nullif(name, symbol), (SELECT n.name FROM market_price_samples n
             WHERE n.symbol = market_price_samples.symbol AND n.name <> n.symbol
             ORDER BY n.observed_at DESC LIMIT 1), symbol) AS name,
           theme, change_rate, turnover, market_cap
    FROM market_price_samples
    WHERE session_date = $1 AND market = 'KR'
      AND source LIKE $2
      AND (observed_at AT TIME ZONE 'Asia/Seoul')::time BETWEEN $3::time AND $4::time
      AND theme IS NOT NULL AND theme NOT IN ('미분류', 'ETF')
      AND change_rate IS NOT NULL
    ORDER BY symbol, observed_at DESC
  `, [sessionDate, bounds.source, bounds.from, bounds.to]);
  const byTheme = new Map();

  for (const row of result.rows) {
    if (excluded.has(row.theme)) continue;

    if (!byTheme.has(row.theme)) byTheme.set(row.theme, []);

    byTheme.get(row.theme).push(row);
  }

  const groups = [];

  for (const [theme, rows] of byTheme) {
    if (rows.length < minimumMembers) continue;

    // The same test rankDayLeaders applies: turnover, and up. Ranking a theme
    // purely by turnover made 현대차 the leader of 자동차·전장 at -4.71% on
    // 2026-08-19, and a theme nobody is buying has no 1등주 to follow.
    const rising = rows.filter((row) => Number(row.turnover ?? 0) > 0 && Number(row.change_rate) > 0);

    if (rising.length === 0) continue;

    const byTurnover = [...rising].sort((left, right) => Number(right.turnover ?? 0) - Number(left.turnover ?? 0));
    const leader = byTurnover[0];
    // The same three tests attachPairCandidates applies, so both panels mean the
    // same thing by "후보": up, takeable, and an ordinary share. Sorted
    // strongest first - the follower already moving with the theme is the one
    // the trade reads, not the one falling hardest.
    const followers = rows
      .filter((row) => row.symbol !== leader.symbol
        && Number(row.change_rate) > 0
        && Number(row.turnover ?? 0) >= minimumCandidateTurnover
        && !isPreferredShare(row.symbol))
      .sort((left, right) => Number(right.change_rate) - Number(left.change_rate))
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
      id: `theme-group-kr-${window}-${theme}`,
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
