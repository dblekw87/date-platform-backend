import { formatTradingAmount } from "./format.mjs";
import { classifyTheme, isEtfLike, isNonOperatingEquity } from "./themes.mjs";
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
      // Same reading as the pair board, and the same demotion: a fact worth
      // showing, not the size of an opportunity.
      leadGap: Number((Number(leader.change_rate) - Number(followers[0].change_rate)).toFixed(2)),
      market: "KR",
      theme
    });
  }

  // Strongest member first, matching buildPairBoard. The gap was measured
  // against 186,726 pairs and orders nothing.
  return groups
    .sort((left, right) => (right.candidates[0]?.changeRateValue ?? 0) - (left.candidates[0]?.changeRateValue ?? 0))
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

export async function loadKrSessionUniverse(config, sessionDate, { etf = false } = {}) {
  if (!config.databaseUrl) return [];

  const result = await query(config, `
    -- 가격은 마지막으로 체결된 곳에서 옵니다. 그게 연속성입니다.
    WITH last_traded AS (
      SELECT DISTINCT ON (symbol) symbol, name, theme, change_rate,
             market_cap, source, observed_at
        FROM market_price_samples
       WHERE session_date = $1 AND market = 'KR'
         AND source LIKE 'kis:%' AND source NOT LIKE '%:pair'
         AND change_rate IS NOT NULL
       ORDER BY symbol, observed_at DESC
    ),
    -- 돈은 KRX 누적에서만 옵니다. 측정: 2026-08-21 상위 18종목 전부에서
    -- KRX 누적 / 네이버 공식 일별 거래대금 = 1.000. NXT 누적은 같은 비교에서
    -- 0.31~1.41로 흩어지고 삼성전자는 하루 총액을 넘깁니다(1.41) -- 그 책의
    -- 자체 집계라 하루 거래대금으로 쓸 수 없습니다. 등락률은 이어 붙여도
    -- 거래대금은 이어 붙이면 안 되는 이유입니다.
    krx_money AS (
      SELECT DISTINCT ON (symbol) symbol, turnover, volume
        FROM market_price_samples
       WHERE session_date = $1 AND market = 'KR' AND source LIKE 'kis:krx%'
       ORDER BY symbol, observed_at DESC
    ),
    last_seen AS (
      SELECT t.symbol, t.name, t.theme, t.change_rate,
             coalesce(m.turnover, 0) AS turnover, m.volume,
             t.market_cap, t.source, t.observed_at
        FROM last_traded t
        LEFT JOIN krx_money m ON m.symbol = t.symbol
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

  return result.rows
    // ETF는 주도주가 아니라 자기 탭으로 갑니다. 지수 펀드에는 테마가 없고, 그
    // 거래대금을 어느 테마에 더하면 "누가 KODEX 200을 샀으니 반도체가 움직인다"는
    // 말이 됩니다. 우선주는 어느 쪽도 아니라 양쪽에서 빠집니다.
    .filter((row) => etf
      ? isEtfLike(row.name)
      : !isEtfLike(row.name) && !isNonOperatingEquity(row.name))
    .map((row) => {
      const venue = row.source.includes("nxt") ? "NXT" : "KRX";
      // 전 종목 표에는 테마가 없습니다. 랭킹 경로가 쓰는 것과 같은 분류기를
      // 태워야 두 출처의 행이 한 목록에서 같은 어휘로 읽힙니다.
      const theme = row.theme ?? classifyTheme(row.symbol, row.name);
      const turnoverValue = row.turnover === null ? 0 : Number(row.turnover);
      const changeRateValue = Number(row.change_rate);
      const turnover = formatTradingAmount(turnoverValue, "KRW");
      const volume = row.volume === null ? null : Number(row.volume);

      // 화면이 읽는 문장들. 랭킹 경로의 toLeadingStock과 같은 모양이어야 합니다 --
      // leaderTheme은 reason의 첫 토막을 테마로 읽으므로, 이 문자열이 없으면
      // 화면이 `reason.split`에서 그대로 터집니다.
      return {
        burst: volume === null
          ? "장중 표본 없음"
          : `당일 거래량 ${volume.toLocaleString("ko-KR")}주`,
        caution: "뉴스·공시 원문과 장중 거래대금 유지 여부 확인",
        changeRateValue,
        id: `kr-${row.symbol}`,
        intraday: `${venue} 마지막 체결 · ${changeRateValue > 0 ? "+" : ""}${changeRateValue.toFixed(2)}%`,
        market: "KR",
        marketCapValue: row.market_cap === null ? undefined : Number(row.market_cap),
        marketLabel: venue,
        name: row.name ?? row.symbol,
        reason: `${theme} · 당일 거래대금 ${turnover} · ${venue} 마지막 체결`,
        source: "kis",
        symbol: row.symbol,
        theme,
        timestamp: new Date(row.observed_at).toISOString(),
        turnover,
        turnoverValue,
        // 마지막 체결이 어느 책이었는지. 정규장 종가로 남아 있는 종목과 저녁까지
        // 거래된 종목이 한 목록에 섞이므로, 행마다 출처를 밝혀야 읽힙니다.
        venue,
        volumeValue: volume === null ? undefined : volume
      };
    });
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

/**
 * 하루가 끝난 뒤의 거래대금·거래량은 KRX 누적입니다.
 *
 * 15:40이 지나면 랭킹 응답이 NXT의 자체 집계로 바뀌는데, 그 값은 하루 거래대금이
 * 아닙니다. 2026-08-21 상위 18종목에서 KRX 누적은 네이버 공식 일별 거래대금과
 * 1.000으로 일치했지만 NXT 누적은 0.31~1.41로 흩어졌고 삼성전자는 하루 총액의
 * 1.41배(10.9조 대 7.68조)를 냈습니다. 그대로 두면 거래대금 1위의 숫자가 틀립니다.
 *
 * 가격은 반대입니다 -- 마지막 체결이 곧 지금 값이므로 NXT 것이 맞습니다. 그래서
 * 돈만 되돌리고 등락률은 건드리지 않습니다.
 *
 * 정규장이 아직 진행 중일 때는 적용하지 않습니다. 그때는 랭킹이 이미 KRX를 보고
 * 있고 기록보다 몇 초 빠릅니다.
 */
export async function loadKrxDayMoney(config, sessionDate) {
  if (!config.databaseUrl) return new Map();

  const result = await query(config, `
    SELECT DISTINCT ON (symbol) symbol, turnover, volume
      FROM market_price_samples
     WHERE session_date = $1 AND market = 'KR' AND source LIKE 'kis:krx%'
     ORDER BY symbol, observed_at DESC
  `, [sessionDate]);

  return new Map(result.rows.map((row) => [row.symbol, {
    turnoverValue: row.turnover === null ? undefined : Number(row.turnover),
    volumeValue: row.volume === null ? undefined : Number(row.volume)
  }]));
}
