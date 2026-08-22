import { query } from "../db/client.mjs";

/**
 * 종가배팅 후보 — 오늘 종가에 사서 내일 시가에 팔 만한 자리.
 *
 * 조건은 추측이 아니라 scripts/measure-close-bet.mjs가 50만 종목-밤에서 남긴
 * 것입니다. 각 항목을 하나씩 빼서 값을 더하는지 확인했습니다.
 *
 *   활성화 양봉   60일 고점을 **오늘** 돌파한 양봉. 어제 이미 위였으면 아닙니다
 *   윗꼬리 30%↓   종가가 고가 근처. 긴 윗꼬리는 장 막판에 미끄러진 것입니다
 *   당일 10%↑     가장 큰 기여. 빼면 초과가 2.215 → 0.502%p로 무너집니다
 *   거래량 2배↑    20일 평균 대비
 *
 * 정배열(5>10>20)은 넣지 않았습니다. 넣으나 빼나 초과가 같은데 후보만 29% 줄고,
 * 단독으로는 50만 표본에서 +0.009%p로 0입니다.
 *
 * 밤은 예측하지 않습니다. 예측할 수도 없습니다 -- 미국과 이란이 전쟁을 하면
 * 코스피는 다 떨어지고 어느 종목을 골랐든 마찬가지입니다. 그래서 화면에 나가는
 * 숫자는 갭이 아니라 **그날 밤 평균 대비 초과분**이고, 나스닥 선물은 옆에 맥락으로
 * 두되 이 숫자에 섞지 않습니다. 섞으면 못 맞히는 것을 맞히는 척하게 됩니다.
 */

// 60거래일 = 약 3개월. "중요한 고점"의 조작적 정의입니다.
const lookback = 60;

// 하루 거래대금 10억 미만은 갭이 호가 한 칸에도 튀어서 후보가 될 수 없습니다.
const minimumTurnover = 1_000_000_000;

const maximumUpperShadow = 0.3;

/**
 * 문턱은 규모마다 다릅니다.
 *
 * 하나로 두면 초대형주가 구조적으로 빠집니다. 당일 10% · 거래량 2배로는 삼성전자와
 * SK하이닉스가 1.6년간 한 번도 안 걸립니다 -- 2026-07-31에 하이닉스가 +29.95%
 * 상한가를 갔는데도 그렇습니다. 폭락 뒤 반등이라 60일 고점을 못 넘었고, 거래량은
 * 1.6배였습니다. 대형주는 원래 거래량이 두 배가 되는 일이 드뭅니다.
 *
 * 규모별로 재보니 문턱이 다르고 엣지도 다릅니다(활성화양봉·윗꼬리 고정, 익일 시가
 * 매도, 그날 밤 평균 대비 초과분).
 *
 *   대형 1조↑     당일 5%↑ · 거래량 1.5배↑   하루 4.0건   +0.653%p
 *   중형 3천억~1조  당일 5%↑ · 거래량 1.5배↑   하루 4.0건   +0.653%p 수준
 *   소형 3천억↓    당일 10%↑ · 거래량 2배↑    하루 6.0건   +2.826%p
 *
 * 대형주 엣지는 소형주의 1/4이지만 0이 아닙니다. 원전 호재로 두산에너빌리티가
 * 오르는 날을 잡자는 것이 이 화면의 목적이고, 그 종목은 소형주 문턱으로는 1.6년에
 * 2일만 걸립니다.
 */
const sizeThresholds = [
  { label: "대형", minCap: 1_000_000_000_000, minDayMove: 5, minVolumeRatio: 1.5 },
  { label: "중형", minCap: 300_000_000_000, minDayMove: 5, minVolumeRatio: 1.5 },
  { label: "소형", minCap: 0, minDayMove: 10, minVolumeRatio: 2 }
];

// 시총을 모르는 종목은 소형 문턱을 씁니다 -- 수집 대상 밖이라는 뜻이고, 그 자체가
// 작다는 신호입니다.
const sizeLabelCase = sizeThresholds
  .map((size) => `WHEN coalesce(cap, 0) >= ${size.minCap} THEN '${size.label}'`)
  .join(" ");

const sizeCase = (column) => sizeThresholds
  .map((size) => `WHEN coalesce(cap, 0) >= ${size.minCap} THEN ${size[column]}`)
  .join(" ");

const minimumDayMove = 5;
const minimumVolumeRatio = 1.5;

/**
 * 등급은 규모입니다.
 *
 * 상승률로 나눴었는데, 규모마다 문턱이 다르면 그 축이 성립하지 않습니다 -- 대형주
 * 5%와 소형주 15%는 같은 등급표에 놓을 수 없습니다. 규모별로 문턱도 성적도 따로
 * 재고 있으므로 등급도 규모를 따릅니다.
 *
 * 전 기간 실측(익일 시가 매도, 그날 밤 평균 대비 초과분):
 *
 *   소형  2,286건 · 하루 6.3건 · 상회 62% · +3.037%p
 *   중형  1,407건 · 하루 4.4건 · 상회 54% · +0.985%p
 *   대형  1,502건 · 하루 4.9건 · 상회 51% · +0.862%p
 */
export const closeBetTiers = sizeThresholds.map((size) => ({ tier: size.label }));

/**
 * 조건을 만족한 하루치를 뽑는 SQL.
 *
 * `session` 이 주어지면 그날, 없으면 가장 최근 거래일입니다. 같은 쿼리를 캘리브레이션이
 * 과거 전체에 대해서도 돌리므로 조건 정의가 두 곳에 갈라지지 않습니다.
 */
export const closeBetCandidateSql = `
  WITH bars AS (
    SELECT symbol, session_date, open, high, low, close, volume,
           close * volume AS turnover,
           lag(close) OVER w AS prev_close,
           lead(open) OVER w AS next_open,
           max(close) OVER (PARTITION BY symbol ORDER BY session_date
                            ROWS BETWEEN ${lookback} PRECEDING AND 1 PRECEDING) AS prior_high,
           max(close) OVER (PARTITION BY symbol ORDER BY session_date
                            ROWS BETWEEN ${lookback + 1} PRECEDING AND 2 PRECEDING) AS prior_high_yesterday,
           avg(volume) OVER (PARTITION BY symbol ORDER BY session_date
                             ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS avg_volume,
           count(*) OVER (PARTITION BY symbol ORDER BY session_date
                          ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS history
      FROM kr_daily_bars
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  )
  , sized AS (
    SELECT b.*, u.market_cap AS cap
      FROM bars b
      LEFT JOIN LATERAL (
        SELECT market_cap FROM kr_daily_universe
         WHERE symbol = b.symbol AND market_cap > 0
         ORDER BY session_date DESC LIMIT 1
      ) u ON true
  )
  SELECT symbol, session_date, open, high, low, close, volume, turnover, prior_high,
         next_open, cap,
         (close / prev_close - 1) * 100 AS day_move,
         (high - close) / nullif(high - low, 0) AS upper_shadow,
         volume / nullif(avg_volume, 0) AS volume_ratio,
         (close / nullif(prior_high, 0) - 1) * 100 AS break_margin,
         CASE ${sizeLabelCase} END AS size_label
    FROM sized
   WHERE prev_close > 0 AND close > 0 AND high > low AND history >= 20
     AND prior_high IS NOT NULL AND prior_high_yesterday IS NOT NULL
     AND close * volume >= ${minimumTurnover}
     AND close > open
     AND close > prior_high
     AND prev_close <= prior_high_yesterday
     AND (high - close) / nullif(high - low, 0) < ${maximumUpperShadow}
     AND (close / prev_close - 1) * 100 >= (CASE ${sizeCase("minDayMove")} END)
     AND volume / nullif(avg_volume, 0) >= (CASE ${sizeCase("minVolumeRatio")} END)
`;

async function loadCalibration(config) {
  const result = await query(
    config,
    "SELECT tier, samples, nights, beat_rate, excess_mean, gap_up_rate, calibrated_from::text, calibrated_to::text FROM kr_close_bet_calibration"
  );

  return new Map(result.rows.map((row) => [row.tier, {
    beatRate: Number(row.beat_rate),
    calibratedFrom: row.calibrated_from,
    calibratedTo: row.calibrated_to,
    excessMean: Number(row.excess_mean),
    gapUpRate: Number(row.gap_up_rate),
    nights: Number(row.nights),
    samples: Number(row.samples)
  }]));
}

/**
 * 장중 후보 -- 아직 캔들이 닫히지 않은 상태로.
 *
 * 일봉만 보면 오늘의 후보는 15:50 수집 이후에야 생깁니다. 그때는 이미 종가에 살 수
 * 없습니다. 종가배팅은 마감 30분 전에 결정하는 매매이므로 목록이 그 시간에 살아
 * 있어야 하고, 그 사이 계속 바뀌는 것이 정상입니다.
 *
 * 그래서 분봉 표본으로 같은 조건을 계산합니다. 가격은 저장하지 않으므로 전일 종가와
 * 등락률로 되살리고, 고가·저가는 오늘 표본 경로의 최대·최소로 근사합니다. 실제
 * 고가·저가는 표본 사이에서 나왔을 수 있으니 윗꼬리는 과소평가될 수 있습니다 --
 * 장중 값이 잠정이라는 뜻이고, 행마다 그렇게 표시합니다.
 *
 * 60일 고점과 20일 평균 거래량은 일봉에서 그대로 옵니다. 그쪽은 어제까지의 사실이라
 * 장중에 바뀌지 않습니다.
 *
 * 모집단은 분봉이 닿는 568종목입니다 -- 전 종목 4,300개는 하루 한 번뿐이라 장중에는
 * 쓸 수 없습니다. 조건이 당일 10%↑에 거래량 2배↑라 그 바깥에 있을 종목은 드물지만,
 * 없다고는 못 합니다.
 */
const liveCandidateSql = `
  WITH context AS (
    SELECT symbol,
           max(close) FILTER (WHERE rn <= ${lookback}) AS prior_high,
           max(close) FILTER (WHERE rn = 1) AS prev_close,
           avg(volume) FILTER (WHERE rn <= 20) AS avg_volume,
           max(close) FILTER (WHERE rn <= ${lookback} AND rn >= 2) AS prior_high_yesterday
      FROM (
        SELECT symbol, close, volume,
               row_number() OVER (PARTITION BY symbol ORDER BY session_date DESC) AS rn
          FROM kr_daily_bars
         WHERE session_date < $1::date
      ) ranked
     GROUP BY symbol
  ),
  today AS (
    SELECT symbol,
           max(name) AS name,
           max(change_rate) AS high_rate,
           min(change_rate) AS low_rate,
           max(turnover) AS turnover,
           max(volume) AS volume,
           max(market_cap) AS market_cap,
           (array_agg(change_rate ORDER BY observed_at DESC))[1] AS change_rate,
           max(observed_at) AS observed_at
      FROM market_price_samples
     WHERE market = 'KR' AND session_date = $1::date
       AND source LIKE 'kis:krx%' AND change_rate IS NOT NULL
     GROUP BY symbol
  )
  SELECT t.symbol, t.name, t.observed_at, t.turnover, t.volume, t.market_cap,
         t.change_rate AS day_move,
         -- 확정 경로와 같은 규모 문턱을 씁니다. 장중과 마감 후에 다른 종목이 뜨면
         -- 그 목록으로는 아무것도 판단할 수 없습니다.
         CASE ${sizeLabelCase.replace(/coalesce\(cap, 0\)/g, "coalesce(t.market_cap, 0)")} END AS size_label,
         c.prev_close * (1 + t.change_rate / 100) AS close,
         c.prior_high,
         (c.prev_close * (1 + t.change_rate / 100) / nullif(c.prior_high, 0) - 1) * 100 AS break_margin,
         t.volume / nullif(c.avg_volume, 0) AS volume_ratio,
         (t.high_rate - t.change_rate) / nullif(t.high_rate - t.low_rate, 0) AS upper_shadow
    FROM today t
    JOIN context c ON c.symbol = t.symbol
   WHERE c.prev_close > 0 AND c.prior_high IS NOT NULL AND c.avg_volume > 0
     AND t.change_rate >= (CASE ${sizeCase("minDayMove").replace(/coalesce\(cap, 0\)/g, "coalesce(t.market_cap, 0)")} END)
     AND t.turnover >= ${minimumTurnover}
     AND t.volume / nullif(c.avg_volume, 0) >= (CASE ${sizeCase("minVolumeRatio").replace(/coalesce\(cap, 0\)/g, "coalesce(t.market_cap, 0)")} END)
     -- 돌파 직후. 어제 종가가 이미 고점 위였다면 이어가는 자리입니다.
     AND c.prev_close * (1 + t.change_rate / 100) > c.prior_high
     AND c.prev_close <= c.prior_high_yesterday
     AND coalesce((t.high_rate - t.change_rate) / nullif(t.high_rate - t.low_rate, 0), 0) < ${maximumUpperShadow}
   ORDER BY t.turnover DESC
   LIMIT $2
`;

/**
 * 후보 목록. 오늘 일봉이 들어와 있으면 그것으로, 아직이면 장중 표본으로 계산합니다.
 *
 * 캘리브레이션이 없으면 빈 목록입니다 -- 성적표 없이 종목만 내놓는 것이 이 화면이
 * 하지 않기로 한 일입니다.
 */
export async function loadCloseBetCandidates(config, { limit = 12, sessionDate } = {}) {
  if (!config.databaseUrl) return [];

  const calibration = await loadCalibration(config).catch(() => new Map());

  if (calibration.size === 0) return [];

  const latestBar = await query(config, "SELECT max(session_date)::text AS day FROM kr_daily_bars");
  const barDay = latestBar.rows[0]?.day ?? null;
  const liveDay = await query(
    config,
    "SELECT max(session_date)::text AS day FROM market_price_samples WHERE market = 'KR' AND source LIKE 'kis:krx%'"
  );
  const sampleDay = sessionDate ?? liveDay.rows[0]?.day ?? null;
  // 오늘 봉이 아직 없으면 장중입니다. 그때는 표본으로 같은 조건을 계산합니다.
  const provisional = Boolean(sampleDay && barDay && sampleDay > barDay);
  const result = provisional
    ? await query(config, liveCandidateSql, [sampleDay, limit])
    : await query(config, `
      WITH candidates AS (${closeBetCandidateSql})
      SELECT c.*, c.session_date::text AS session_day, u.name, u.market, u.market_cap, u.trade_halted
        FROM candidates c
        LEFT JOIN kr_daily_universe u
          ON u.symbol = c.symbol AND u.session_date = c.session_date
       WHERE c.session_date = (SELECT max(session_date) FROM kr_daily_bars)
       ORDER BY c.turnover DESC
       LIMIT $1
    `, [limit]);

  return result.rows
    // 거래정지된 종목은 살 수 없습니다. 조건은 어제 만족했을 수 있어도 후보가
    // 아닙니다.
    .filter((row) => !row.trade_halted)
    .map((row) => {
      const dayMove = Number(row.day_move);
      const tier = row.size_label ?? "소형";
      const measured = calibration.get(tier);

      return {
        breakMargin: Number(Number(row.break_margin).toFixed(2)),
        changeRateValue: Number(dayMove.toFixed(2)),
        closePrice: Number(row.close),
        id: `close-bet-${row.symbol}`,
        market: row.market ?? "KR",
        marketCapValue: row.market_cap === null ? null : Number(row.market_cap),
        measured: measured
          ? {
            beatRate: measured.beatRate,
            excessMean: measured.excessMean,
            gapUpRate: measured.gapUpRate,
            nights: measured.nights,
            samples: measured.samples,
            window: `${measured.calibratedFrom} ~ ${measured.calibratedTo}`
          }
          : null,
        name: row.name ?? row.symbol,
        // pg는 date를 로컬 자정 Date로 돌려주므로 문자열로 만들면 "Fri Aug 21"이
        // 됩니다. SQL에서 text로 캐스팅한 값을 씁니다.
        observedAt: row.observed_at ? new Date(row.observed_at).toISOString() : null,
        provisional,
        sessionDate: row.session_day ?? sampleDay ?? barDay,
        symbol: row.symbol,
        tier,
        turnoverValue: Number(row.turnover),
        upperShadow: Number(Number(row.upper_shadow).toFixed(3)),
        volumeRatio: Number(Number(row.volume_ratio).toFixed(2))
      };
    });
}
