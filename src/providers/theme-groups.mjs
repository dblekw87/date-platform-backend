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

/**
 * The stocks of one session, shaped the way the leader board shapes them.
 *
 * 강세 테마 was built from whatever book happens to be open, so after 15:40 the
 * panel headed "국내 강세 테마" was quietly describing the NXT evening, and the
 * regular session it appeared to be about had no panel at all. Reading each
 * window out of the record gives both a list that is true to the hours it
 * names, the same way the 짝꿍 panels already work.
 *
 * Grouping stays on the browser side: `rankedThemeGroups` is what decides a
 * theme needs two rising names, and having one rule in one place is worth more
 * than saving the rows.
 */
export async function loadThemeStocks(config, sessionDate, { window = "regular" } = {}) {
  if (!config.databaseUrl) return [];

  const bounds = windows[window] ?? windows.regular;
  const result = await query(config, `
    SELECT DISTINCT ON (symbol) symbol,
           coalesce(nullif(name, symbol), symbol) AS name,
           theme, change_rate, turnover, volume, market_cap
      FROM market_price_samples
     WHERE session_date = $1 AND market = 'KR'
       AND source LIKE $2
       AND (observed_at AT TIME ZONE 'Asia/Seoul')::time BETWEEN $3::time AND $4::time
       AND theme IS NOT NULL AND theme NOT IN ('미분류', 'ETF')
       AND change_rate IS NOT NULL
     ORDER BY symbol, observed_at DESC
  `, [sessionDate, bounds.source, bounds.from, bounds.to]);

  return result.rows.map((row) => ({
    changeRateValue: Number(row.change_rate),
    id: `${window}-${row.symbol}`,
    market: "KR",
    marketCapValue: row.market_cap === null ? undefined : Number(row.market_cap),
    marketLabel: window === "after" ? "NXT" : "KRX",
    name: row.name,
    symbol: row.symbol,
    theme: row.theme,
    turnoverValue: row.turnover === null ? 0 : Number(row.turnover),
    venue: window === "after" ? "NXT" : "KRX",
    volumeValue: row.volume === null ? undefined : Number(row.volume)
  }));
}

/**
 * 종목별 세션 종가 등락률 — 정규장과 NXT 애프터마켓을 따로.
 *
 * 화면의 상승률은 지금 열려 있는 책 하나만 말합니다. 그래서 20:02가 지나면 KRX
 * 종가로 돌아가 쿠콘이 +23.17%로 남는데, 같은 시각 토스는 애프터마켓까지 반영한
 * +19.03%를 보여줍니다. 둘 다 맞는 숫자이고 가리키는 시점만 다릅니다 — 그러니
 * 하나를 고르는 대신 둘 다 이름표를 달고 나란히 서야 합니다.
 *
 * 두 값의 차이 자체가 정보입니다. 정규장에서 상한가에 붙었다가 저녁에 풀린 종목과
 * 저녁까지 붙어 있는 종목은 다음 날 아침이 다릅니다.
 */
export async function loadSessionChangeRates(config, sessionDate) {
  if (!config.databaseUrl) return new Map();

  const result = await query(config, `
    SELECT symbol, session_window, change_rate
      FROM (
        -- window is reserved in SQL, so the column cannot be called that.
        SELECT DISTINCT ON (symbol, session_window) symbol, session_window, change_rate
          FROM (
            SELECT symbol, change_rate, observed_at,
                   CASE WHEN source = 'kis:nxt:after' THEN 'after' ELSE 'regular' END AS session_window
              FROM market_price_samples
             WHERE session_date = $1 AND market = 'KR' AND change_rate IS NOT NULL
               AND (
                 -- 15:40, not 15:30. The closing auction settles at 15:30 and
                 -- the settled figure lands in the samples just after it: 쿠콘
                 -- reads 22.71% at 15:30 and 23.17% at 15:39, and 23.17% is the
                 -- close. The evening does not start until 15:40, so nothing
                 -- from the other book can leak in.
                 (source LIKE 'kis:krx%'
                   AND (observed_at AT TIME ZONE 'Asia/Seoul')::time BETWEEN '09:00' AND '15:40')
                 OR (source = 'kis:nxt:after'
                   AND (observed_at AT TIME ZONE 'Asia/Seoul')::time BETWEEN '15:40' AND '20:02')
               )
          ) windowed
         ORDER BY symbol, session_window, observed_at DESC
      ) latest
  `, [sessionDate]);
  const bySymbol = new Map();

  result.rows.forEach((row) => {
    const entry = bySymbol.get(row.symbol) ?? {};

    entry[row.session_window] = Number(row.change_rate);
    bySymbol.set(row.symbol, entry);
  });

  return bySymbol;
}
