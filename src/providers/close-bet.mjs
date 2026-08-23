import { loadNightTriggers } from "./night-triggers.mjs";
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
 *   회전율 5%↑    상장주식수의 5%가 손바뀌었는가. 거래량 배수를 대체했습니다
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
 * 하나로 두면 초대형주가 구조적으로 빠집니다. 당일 10% 문턱으로는 삼성전자와
 * SK하이닉스가 1.6년간 한 번도 안 걸립니다 -- 2026-07-31에 하이닉스가 +29.95%
 * 상한가를 갔는데도 그렇습니다. 폭락 뒤 반등이라 60일 고점을 못 넘었고, 거래량은
 * 1.6배였습니다. 대형주는 원래 거래량이 두 배가 되는 일이 드뭅니다.
 *
 * 규모별로 재보니 당일 상승률 문턱이 다르고 엣지도 다릅니다(활성화양봉·윗꼬리·
 * 회전율 고정, 익일 시가 매도, 그날 밤 평균 대비 초과분).
 *
 *   대형 1조↑     당일 5%↑    하루 1.2건   +1.200%p
 *   중형 3천억~1조  당일 5%↑    하루 1.8건   +0.877%p
 *   소형 3천억↓    당일 10%↑   하루 5.5건   +3.016%p
 *
 * 대형주 엣지는 소형주의 1/3이지만 0이 아닙니다. 원전 호재로 두산에너빌리티가
 * 오르는 날을 잡자는 것이 이 화면의 목적이고, 그 종목은 소형주 문턱으로는 1.6년에
 * 2일만 걸립니다.
 */
const sizeThresholds = [
  { label: "대형", minCap: 1_000_000_000_000, minDayMove: 5 },
  { label: "중형", minCap: 300_000_000_000, minDayMove: 5 },
  { label: "소형", minCap: 0, minDayMove: 10 }
];

/**
 * 거래가 얼마나 격렬했는가 -- 회전율로 잽니다. 상장주식수의 몇 %가 손바뀌었는가.
 *
 * 원래는 자기 20일 평균 대비 거래량 배수였고 규모마다 문턱이 달랐습니다
 * (대·중형 1.5배 / 소형 2배). 셋으로 쪼갠 이유는 거래량 배수가 크기를 못 걸러내서
 * 입니다 -- 대형주는 거래량이 두 배 되는 일이 원래 드뭅니다. 회전율은 애초에
 * 주식수로 나눈 값이라 그 문제가 없고, 실측에서 문턱 셋보다 나았습니다.
 *
 * 39만 종목-밤 · 380개 장, 같은 구간으로 재비교:
 *
 *              거래량 배수(옛)          회전율 5%
 *   대형        +0.653%p  하루 4.0건    +1.200%p  하루 1.2건
 *   중형        +0.776%p  하루 3.7건    +0.877%p  하루 1.8건
 *   소형        +2.826%p  하루 6.0건    +3.016%p  하루 5.5건
 *   전체        +1.643%p  상회 52%      +2.311%p  상회 57%
 *
 * 같은 것을 두 번 재는 것이 아닙니다 -- 옛 조건을 이미 통과한 행만 회전율로 다시
 * 가르면 0~1% +0.211%p에서 10%↑ +2.591%p로 열두 배 벌어집니다.
 *
 * 10%로 올리면 초과가 조금 더 크지만(+2.445%p) 대형주가 하루 0.6건으로 떨어집니다.
 * 규모별로 나눈 목적이 대형주를 살리는 것이었으므로 5%에 둡니다.
 *
 * 미국 급등 모델의 회전율 68배와는 **관계가 없습니다.** 그것은 10거래일 안에
 * 급등하는가를 잰 숫자이고 이것은 하룻밤입니다. 같은 자를 다른 질문에 각각
 * 대봤을 뿐입니다.
 */
const minimumTurnoverRatio = 5;

// 시총을 모르는 종목은 소형 문턱을 씁니다 -- 수집 대상 밖이라는 뜻이고, 그 자체가
// 작다는 신호입니다.
const sizeLabelCase = sizeThresholds
  .map((size) => `WHEN coalesce(cap, 0) >= ${size.minCap} THEN '${size.label}'`)
  .join(" ");

const sizeCase = (column) => sizeThresholds
  .map((size) => `WHEN coalesce(cap, 0) >= ${size.minCap} THEN ${size[column]}`)
  .join(" ");

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
 * 캘리브레이션이 같은 문자열을 전 기간에 대해서도 돌리므로 조건 정의가 두 곳으로
 * 갈라지지 않습니다.
 *
 * `since`는 성능을 위한 것이지 조건이 아닙니다. 창은 60일 신고점과 20일 평균
 * 거래량이라 그만큼의 과거만 있으면 답이 같은데, 경계를 안 주면 윈도우 함수가
 * 일봉 147만 행 전체를 훑습니다 -- 보드 콜드 빌드가 41초였고 그중 32초가 이
 * 쿼리였습니다. 하루치를 뽑을 때는 200일만 봅니다.
 *
 * 시가총액은 CTE로 한 번에 모읍니다. LATERAL로 두면 행마다 서브쿼리가 돌고,
 * 그 행이 147만 개입니다.
 */
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

// 창이 60일 신고점과 20일 평균이라 200거래일이면 넉넉합니다. 달력 기준이므로
// 휴장일을 감안해 300일을 뺍니다.
const historyDays = 300;

function historyBoundFor(day) {
  if (!day || !datePattern.test(day)) return null;

  const bound = new Date(`${day}T00:00:00Z`);

  bound.setUTCDate(bound.getUTCDate() - historyDays);

  return bound.toISOString().slice(0, 10);
}

// 등급이 무엇이든 이 아래로는 후보가 될 수 없습니다. 문턱 표에서 뽑으므로 표를
// 고치면 같이 움직입니다.
const dayMoveFloor = Math.min(...sizeThresholds.map((size) => size.minDayMove));

/**
 * 하루치를 물을 때, 그날 하루만 보고도 탈락이 확실한 종목을 먼저 걷어냅니다.
 *
 * 여기 있는 조건은 전부 아래 WHERE에도 그대로 있습니다 -- 새 조건이 아니라 같은
 * 조건을 일찍 적용하는 것이라 답이 바뀌지 않습니다. 이걸 안 하면 60일 이동최대값을
 * 77만 행에 대해 계산해 놓고 그중 4천 행만 씁니다(18초 중 18초가 그 창이었습니다).
 */
function symbolPrefilter(day) {
  return `
  symbols AS (
    SELECT symbol
      FROM (
        SELECT symbol, session_date, open, high, low, close, volume,
               lag(close) OVER (PARTITION BY symbol ORDER BY session_date) AS prev_close
          FROM kr_daily_bars
         WHERE session_date BETWEEN '${day}'::date - 10 AND '${day}'::date
      ) recent
     WHERE session_date = '${day}'::date
       AND prev_close > 0 AND close > 0 AND high > low
       AND close > open
       AND close * volume >= ${minimumTurnover}
       AND (high - close) / nullif(high - low, 0) < ${maximumUpperShadow}
       AND (close / prev_close - 1) * 100 >= ${dayMoveFloor}
  ),`;
}

export function closeBetCandidateSql({ day = null, since = null } = {}) {
  // 내부에서 만든 날짜만 들어오지만, 문자열로 끼우는 이상 모양은 확인합니다.
  const oneDay = day && datePattern.test(day) ? day : null;
  const bounds = [
    since && datePattern.test(since) ? `session_date >= '${since}'::date` : null,
    oneDay ? `symbol IN (SELECT symbol FROM symbols)` : null
  ].filter(Boolean);
  const bound = bounds.length ? `WHERE ${bounds.join(" AND ")}` : "";

  return `
  WITH ${oneDay ? symbolPrefilter(oneDay) : ""}
  caps AS (
    -- 주식수는 시가총액 ÷ 종가입니다. 별도 컬럼이 없고, universe가 하루치 스냅샷이라
    -- 그 값을 과거 전체에 씁니다 -- 그 사이 액면분할이나 증자가 있었던 종목은
    -- 회전율이 틀립니다. 규모 구간을 나눌 때 이미 같은 근사를 쓰고 있습니다.
    SELECT DISTINCT ON (symbol) symbol, market_cap AS cap,
           market_cap / nullif(close_price, 0) AS share_count
      FROM kr_daily_universe
     WHERE market_cap > 0 AND close_price > 0
     ORDER BY symbol, session_date DESC
  ),
  bars AS (
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
      ${bound}
     WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
  ),
  sized AS (
    SELECT b.*, c.cap, c.share_count
      FROM bars b
      LEFT JOIN caps c ON c.symbol = b.symbol
  )
  SELECT symbol, session_date, open, high, low, close, volume, turnover, prior_high,
         next_open, cap,
         (close / prev_close - 1) * 100 AS day_move,
         (high - close) / nullif(high - low, 0) AS upper_shadow,
         volume / nullif(share_count, 0) * 100 AS turnover_ratio,
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
     AND volume / nullif(share_count, 0) * 100 >= ${minimumTurnoverRatio}`;
}

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
 * 쓸 수 없습니다. 조건이 당일 10%↑에 회전율 5%↑라 그 바깥에 있을 종목은 드물지만,
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
           -- 시총과 등락률은 **같은 표본**에서 가져와야 합니다. max(시총)은 그날
           -- 고가 시점의 값이라 마지막 가격으로 나누면 주식수가 부풀고, 회전율이
           -- 그만큼 과소평가됩니다 -- 실측으로 평균 4.1% 어긋났고 567종목 중 172개가
           -- 5%를 넘었습니다. 시총이 없는 표본이 17%라 있는 것 중 가장 최근을 씁니다.
           (array_agg(market_cap ORDER BY observed_at DESC) FILTER (WHERE market_cap IS NOT NULL))[1] AS market_cap,
           (array_agg(change_rate ORDER BY observed_at DESC) FILTER (WHERE market_cap IS NOT NULL))[1] AS cap_rate,
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
         -- 주식수 = 시총 ÷ 그 시총을 찍은 시점의 가격. 주식수는 장중에 안 변하므로
         -- 이렇게 내면 확정 경로와 같은 값이 나옵니다.
         t.volume / nullif(t.market_cap / nullif(c.prev_close * (1 + t.cap_rate / 100), 0), 0) * 100 AS turnover_ratio,
         t.volume / nullif(c.avg_volume, 0) AS volume_ratio,
         (t.high_rate - t.change_rate) / nullif(t.high_rate - t.low_rate, 0) AS upper_shadow
    FROM today t
    JOIN context c ON c.symbol = t.symbol
   WHERE c.prev_close > 0 AND c.prior_high IS NOT NULL AND c.avg_volume > 0
     AND t.change_rate >= (CASE ${sizeCase("minDayMove").replace(/coalesce\(cap, 0\)/g, "coalesce(t.market_cap, 0)")} END)
     AND t.turnover >= ${minimumTurnover}
     AND t.volume / nullif(t.market_cap / nullif(c.prev_close * (1 + t.cap_rate / 100), 0), 0) * 100 >= ${minimumTurnoverRatio}
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
      WITH candidates AS (${closeBetCandidateSql({ day: barDay, since: historyBoundFor(barDay) })})
      SELECT c.*, c.session_date::text AS session_day, u.name, u.market, u.market_cap, u.trade_halted
        FROM candidates c
        LEFT JOIN kr_daily_universe u
          ON u.symbol = c.symbol AND u.session_date = c.session_date
       WHERE c.session_date = (SELECT max(session_date) FROM kr_daily_bars)
       ORDER BY c.turnover DESC
       LIMIT $1
    `, [limit]);

  // 거래정지된 종목은 살 수 없습니다. 조건은 어제 만족했을 수 있어도 후보가
  // 아닙니다.
  const tradable = result.rows.filter((row) => !row.trade_halted);
  const nightTriggers = await loadNightTriggers(config, tradable.map((row) => row.symbol));

  return tradable
    .map((row) => {
      const dayMove = Number(row.day_move);
      const tier = row.size_label ?? "소형";
      const measured = calibration.get(tier);
      // 이 종목의 밤을 좌우하는 미국 지표. 재 놓은 두 갈래(반도체·가상화폐)
      // 밖이면 null이고, 화면은 시장 전체의 밤만 말합니다.
      const nightTrigger = nightTriggers.get(row.symbol) ?? null;

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
        nightTrigger,
        // pg는 date를 로컬 자정 Date로 돌려주므로 문자열로 만들면 "Fri Aug 21"이
        // 됩니다. SQL에서 text로 캐스팅한 값을 씁니다.
        observedAt: row.observed_at ? new Date(row.observed_at).toISOString() : null,
        provisional,
        sessionDate: row.session_day ?? sampleDay ?? barDay,
        symbol: row.symbol,
        tier,
        turnoverRatio: Number(Number(row.turnover_ratio).toFixed(2)),
        turnoverValue: Number(row.turnover),
        upperShadow: Number(Number(row.upper_shadow).toFixed(3)),
        volumeRatio: Number(Number(row.volume_ratio).toFixed(2))
      };
    });
}
