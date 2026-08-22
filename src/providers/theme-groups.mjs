import { formatTradingAmount } from "./format.mjs";
import { classifyTheme } from "./themes.mjs";
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

/**
 * 오늘 우리가 본 모든 국내 종목의 마지막 체결 — 어느 책이 열려 있든.
 *
 * 화면의 목록은 지금 열려 있는 랭킹 하나에서 나옵니다. 그래서 15:40이 지나면
 * 모집단이 NXT 애프터마켓 174종목으로 갈아치워지고, 저녁에 거래가 없던 종목은
 * 통째로 사라집니다 -- 2026-08-21 상한가 종목인 파라택시스이더리움(+29.96%),
 * 이노메트리(+29.88%), 원풍물산(+29.85%)이 상승률 탭에서 빠지고 1위가 코미코
 * (+24.31%)로 시작했습니다. 토스는 같은 시각 그 종목들을 정규장 종가 그대로
 * 들고 있습니다. 사라진 게 아니라 그 책에서 거래가 없었을 뿐이니까요.
 *
 * 그래서 모집단은 "지금 열린 책"이 아니라 "오늘 본 전부"여야 하고, 각 종목의
 * 값은 그 종목이 마지막으로 체결된 곳의 값이어야 합니다.
 *
 * :pair는 뺍니다. 짝꿍 후보 패스는 순위가 아니라 특정 종목을 지목해 물어본
 * 것이라, 그 종목이 그날 시장에서 눈에 띄었다는 뜻이 아닙니다.
 *
 * 페이로드가 무한정 커지지 않도록 세 지표별 상위만 남깁니다. 탭마다 30개를
 * 보여주므로 지표별 60개면 어느 탭을 눌러도 정확한 상위 30개가 있습니다.
 */
const universePerMetric = 60;

export async function loadKrSessionUniverse(config, sessionDate) {
  if (!config.databaseUrl) return [];

  const result = await query(config, `
    WITH last_seen AS (
      SELECT DISTINCT ON (symbol) symbol, name, theme, change_rate, turnover,
             volume, market_cap, source, observed_at
        FROM market_price_samples
       WHERE session_date = $1 AND market = 'KR'
         AND source LIKE 'kis:%' AND source NOT LIKE '%:pair'
         AND change_rate IS NOT NULL
       ORDER BY symbol, observed_at DESC
    ),
    -- 랭킹에 한 번도 못 든 종목은 여기서만 옵니다. 오가닉티코스메틱은 8/21에
    -- +29.90%로 마감했는데 거래대금이 6억이라 KIS 어느 순위에도 없었고, 그래서
    -- 위 CTE에 행이 하나도 없습니다. 하루 한 번 받아둔 전 종목 종가가 메웁니다.
    daily AS (
      SELECT u.symbol, u.name, NULL::text AS theme, u.change_rate, u.turnover,
             u.volume, u.market_cap, 'kr:daily'::text AS source,
             u.observed_at
        FROM kr_daily_universe u
       WHERE u.session_date = $1
         AND NOT EXISTS (SELECT 1 FROM last_seen l WHERE l.symbol = u.symbol)
    ),
    merged AS (
      SELECT * FROM last_seen
      UNION ALL
      SELECT * FROM daily
    ),
    ranked AS (
      SELECT *,
             row_number() OVER (ORDER BY turnover DESC NULLS LAST) AS turnover_rank,
             row_number() OVER (ORDER BY change_rate DESC NULLS LAST) AS change_rank,
             row_number() OVER (ORDER BY volume DESC NULLS LAST) AS volume_rank
        FROM merged
    )
    SELECT * FROM ranked
     WHERE turnover_rank <= $2 OR change_rank <= $2 OR volume_rank <= $2
  `, [sessionDate, universePerMetric]);

  return result.rows.map((row) => ({
    changeRateValue: Number(row.change_rate),
    id: `kr-${row.symbol}`,
    market: "KR",
    marketCapValue: row.market_cap === null ? undefined : Number(row.market_cap),
    marketLabel: row.source.includes("nxt") ? "NXT" : "KRX",
    name: row.name,
    // 마지막 체결이 어느 책이었는지. 정규장 종가로 남아 있는 종목과 저녁까지
    // 거래된 종목이 한 목록에 섞이므로, 행마다 출처를 밝혀야 읽힙니다.
    source: "kis",
    symbol: row.symbol,
    // 전 종목 표에는 테마가 없습니다. 랭킹 경로가 쓰는 것과 같은 분류기를 태워야
    // 두 출처의 행이 한 목록에서 같은 어휘로 읽힙니다.
    theme: row.theme ?? classifyTheme(row.symbol, row.name),
    turnoverValue: row.turnover === null ? 0 : Number(row.turnover),
    venue: row.source.includes("nxt") ? "NXT" : "KRX",
    volumeValue: row.volume === null ? undefined : Number(row.volume)
  }));
}

/**
 * 표본이 실제로 있는 가장 최근 장 날짜.
 *
 * `sessionDate("KR")`은 달력이 말하는 오늘입니다. 토요일 새벽이나 월요일 개장 전에
 * 그 날짜로 기록을 읽으면 아무것도 안 나오고, 화면은 조용히 비거나 -- 더 나쁘게 --
 * 낡은 랭킹 응답으로 되돌아갑니다. 2026-08-23(일)에 강세 테마 패널이 `미분류`
 * 26종목으로 채워진 게 그것이었습니다. 주말에는 금요일 장을 보여주는 것이 맞습니다.
 */
export async function latestKrSessionDate(config, fallback) {
  if (!config.databaseUrl) return fallback;

  const result = await query(
    config,
    `SELECT max(session_date)::text AS session_date
       FROM market_price_samples
      WHERE market = 'KR' AND source LIKE 'kis:%'`
  );

  return result.rows[0]?.session_date ?? fallback;
}
