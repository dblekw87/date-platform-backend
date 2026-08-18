import { query } from "../db/client.mjs";
import { formatTradingAmount } from "./format.mjs";

/**
 * Tonight's US stocks most likely to run, ranked by measured probability.
 *
 * Unlike every other provider here the source is our own database, because the
 * answer is not something any vendor publishes. It is read off two years of
 * daily bars (us_daily_bars), the events those bars contain (us_surge_events),
 * the share counts that make the events possible (us_share_counts) and the
 * bucket rates counted from all three (us_surge_calibration).
 *
 * There is no price cap and no market cap cap. An earlier version had both and
 * they were the wrong shape of answer: a stock is a candidate because of how
 * often stocks like it have run, not because it is cheap. Size and price still
 * decide the ranking, but they do it through the measured rate rather than
 * through a threshold that silently deletes everything above it.
 *
 * The ordering key is a frequency, not a score. Every name carries the rate of
 * its bucket — how many stock-days in that bucket were followed by a +50%
 * session inside the window, out of how many there were — which is as much as
 * the data supports and is honest about being a base rate rather than a
 * forecast for this particular company.
 *
 * Turnover against SHARE COUNT is what separates the buckets: 18.7% at the top
 * against 0.19% for stocks trading under 1% of their shares. Measured the other
 * way, against a stock's own recent average, there is no signal at all — the
 * median surge had a completely ordinary day before it. That distinction is why
 * share counts had to be loaded before any of this could be written.
 *
 * What this cannot do is find the $8 stock that opens +170% on an FDA decision.
 * Those events show a median prior-day turnover of 1.8%; there is no warning in
 * the price data because the cause is not in the price data. Covering them
 * needs a calendar of scheduled catalysts, not a better ranking.
 *
 * Nothing here reads today's tape. Every value comes from sessions strictly
 * before the one being predicted, which is the whole point: a list built out of
 * today's gainers is a record of what already happened.
 */

// Not a view on which stocks are interesting — just the floor below which a
// price is quoted rather than traded, and a move could not have been acted on.
const eligibility = {
  minDollarVolume: 100_000,
  minPrice: 0.1
};

export async function loadUsSurgeCandidates(config, { horizonDays = 5, limit = 25, sessionDate } = {}) {
  const result = await query(
    config,
    `WITH latest AS (
       SELECT coalesce($1::date, max(session_date)) AS session_date
       FROM us_daily_bars
     ),
     bars AS (
       SELECT b.symbol, b.session_date, b.close, b.volume, b.close * b.volume AS dollar_volume
       FROM us_daily_bars b, latest l
       WHERE b.session_date = l.session_date
         AND b.close >= $2
         AND b.close * b.volume >= $3
     ),
     priced AS (
       -- Formatted as text rather than handed over as a date. A DATE arrives in
       -- the driver as local midnight, and every consumer of this list is
       -- thirteen hours ahead of the session it describes, which turns Thursday
       -- into Wednesday on the way to the screen.
       SELECT b.symbol, t.name, b.close, b.volume, b.dollar_volume,
              to_char(b.session_date, 'YYYY-MM-DD') AS session_date,
              s.shares,
              b.close * s.shares AS market_cap,
              b.volume / s.shares AS turnover,
              (
                SELECT b.session_date - max(e.session_date) FROM us_surge_events e
                WHERE e.symbol = b.symbol AND e.session_date <= b.session_date
              ) AS days_since_last_run,
              (
                SELECT min(b.session_date - sp.execution_date) FROM us_splits sp
                WHERE sp.symbol = b.symbol
                  AND sp.execution_date BETWEEN b.session_date - 180 AND b.session_date
                  AND sp.split_to < sp.split_from
              ) AS reverse_split_days,
              -- The newest catalyst filing in the window the rate was measured
              -- over. Carried out whole rather than as a flag because a row
              -- saying "424B4 신주 발행 확정, 어제" is the answer to why this
              -- name is here, and a checkmark is not.
              (
                SELECT to_jsonb(hit) FROM (
                  SELECT cf.form_type, cf.label,
                         b.session_date - f.filed_date AS days_ago
                  FROM us_filings f
                  JOIN us_catalyst_forms cf ON cf.form_type = f.form_type
                  WHERE f.cik = t.cik
                    AND f.filed_date BETWEEN b.session_date - 3 AND b.session_date
                  ORDER BY f.filed_date DESC, cf.measured_rate DESC NULLS LAST
                  LIMIT 1
                ) hit
              ) AS catalyst
       FROM bars b
       JOIN LATERAL (
         SELECT u.cik, u.name FROM us_tickers u
         WHERE u.symbol = b.symbol AND u.as_of <= b.session_date AND u.cik IS NOT NULL
           AND u.type IN ('CS', 'ADRC')
         ORDER BY u.as_of DESC LIMIT 1
       ) t ON true
       JOIN LATERAL (
         -- The exchange listing first, the filer second. For a foreign issuer
         -- the SEC count is ordinary shares while the ADS is what trades, and
         -- taking it at face value priced Steakholder Foods at $15.7B against a
         -- real $2.0M. Where us_listed_shares has an answer it is the security
         -- that actually changes hands.
         SELECT coalesce(
           (SELECT ls.shares FROM us_listed_shares ls
            WHERE ls.symbol = b.symbol AND ls.shares >= 100000
            ORDER BY ls.as_of DESC LIMIT 1),
           -- A handful of filers put 1, 7 or 12 in the shares-outstanding tag,
           -- which makes a listed company look like a $12 business trading
           -- 300,000 times its stock in a day. No listed common has six figures
           -- of shares or fewer, so the floor is a typo filter, not a screen.
           (SELECT sc.shares FROM us_share_counts sc
            WHERE sc.cik = t.cik AND sc.period_end <= b.session_date
              AND sc.shares >= 100000
            ORDER BY sc.period_end DESC LIMIT 1)
         ) AS shares
       ) s ON s.shares IS NOT NULL
       -- The share floor catches filers that reported 1 or 7 shares. It does
       -- not catch a count so stale that a listed company prices out at
       -- $172,889, which is what GPUS showed after a year of daily issuance.
       -- Nothing on an exchange is worth less than a million dollars.
       WHERE b.close * s.shares >= 1e6
     )
     SELECT p.*,
            c.rate, c.observations, c.filing_bucket
     FROM priced p
     -- Prefer the rate measured with the filing axis, fall back to the rollup
     -- without it. Four dimensions divides two years thin, and a cell counted
     -- off forty observations would top the list on noise alone.
     JOIN LATERAL (
       SELECT c.rate, c.observations, c.filing_bucket
       FROM us_surge_calibration c
       WHERE c.horizon_days = $4
      AND c.turnover_bucket = CASE
            WHEN p.turnover >= 1.0 THEN 'F 100%+'
            WHEN p.turnover >= 0.5 THEN 'E 50-100%'
            WHEN p.turnover >= 0.2 THEN 'D 20-50%'
            WHEN p.turnover >= 0.05 THEN 'C 5-20%'
            WHEN p.turnover >= 0.01 THEN 'B 1-5%'
            ELSE 'A <1%' END
      AND c.market_cap_bucket = CASE
            WHEN p.market_cap < 25e6 THEN 'A <25M'
            WHEN p.market_cap < 100e6 THEN 'B 25-100M'
            WHEN p.market_cap < 500e6 THEN 'C 100-500M'
            WHEN p.market_cap < 2e9 THEN 'D 0.5-2B'
            ELSE 'E 2B+' END
      -- Kept as a dimension rather than a filter. A stock that ran this week
      -- carries the best odds on the board (24.6% against 9.1% for one that has
      -- never run) and is also the one a reader would call "already up", so it
      -- stays in the list and says which it is.
      AND c.recency_bucket = CASE
            WHEN p.days_since_last_run IS NULL THEN 'Z 이력없음'
            WHEN p.days_since_last_run = 0 THEN 'A 당일'
            WHEN p.days_since_last_run <= 5 THEN 'B 1-5일'
            WHEN p.days_since_last_run <= 20 THEN 'C 6-20일'
            WHEN p.days_since_last_run <= 90 THEN 'D 21-90일'
            ELSE 'E 90일초과' END
      AND c.filing_bucket IN (
            CASE WHEN p.catalyst IS NULL THEN 'N 공시없음' ELSE 'Y 공시있음' END,
            'any')
       -- Thin cells are not evidence. A bucket seen fifty times can read 20% off
       -- ten coincidences, and it would sit at the top of the list every day.
       AND c.observations >= 200
       ORDER BY (c.filing_bucket <> 'any') DESC
       LIMIT 1
     ) c ON true
     ORDER BY c.rate DESC, p.turnover DESC
     LIMIT $5`,
    // Deep enough to fill both quotas below. Sorting the two groups against
    // each other in SQL cannot work either way round: probability alone fills
    // the list with continuations, and putting the quiet names first buries the
    // continuations entirely — there were over four hundred of the former on
    // 2026-08-13, so not one of the latter reached a screen.
    [sessionDate ?? null, eligibility.minPrice, eligibility.minDollarVolume, horizonDays, limit * 20]
  );

  const ranked = result.rows.map((row) => ({
    catalyst: row.catalyst ?? null,
    close: Number(row.close),
    daysSinceLastRun: row.days_since_last_run === null ? null : Number(row.days_since_last_run),
    dollarVolume: Number(row.dollar_volume),
    marketCap: Number(row.market_cap),
    name: row.name,
    // What the rate is based on, so a reader can weigh it.
    filingBucket: row.filing_bucket,
    observations: Number(row.observations),
    probability: Number(row.rate),
    reverseSplitDays: row.reverse_split_days === null ? null : Number(row.reverse_split_days),
    shares: Number(row.shares),
    symbol: row.symbol,
    turnover: Number(row.turnover)
  }));

  const isWaiting = (candidate) => candidate.daysSinceLastRun === null || candidate.daysSinceLastRun > 5;
  // Two thirds to the stocks that have not moved, because that is the question
  // being asked, and a third to the ones still moving, because they carry the
  // higher measured rate and a reader is entitled to see it.
  const waitingQuota = Math.max(1, Math.round((limit * 2) / 3));
  const waiting = ranked.filter(isWaiting).slice(0, waitingQuota);
  const running = ranked.filter((candidate) => !isWaiting(candidate)).slice(0, limit - waiting.length);

  return {
    asOf: result.rows[0]?.session_date ?? null,
    candidates: [...waiting, ...running],
    horizonDays
  };
}

function formatPrice(value) {
  return value >= 10 ? `$${value.toFixed(2)}` : `$${value.toFixed(3).replace(/0$/, "")}`;
}

/**
 * The board's shape for a candidate.
 *
 * The probability is carried as a number as well as a string because the screen
 * has to be able to say it plainly. A list of small caps with no number beside
 * them reads as a tip sheet; the same list reading "5일 내 급등 확률 18.7%" is a
 * measurement, and the difference is the whole point of having counted.
 */
function toSurgeCandidateDto(candidate, { asOf, horizonDays }) {
  const percent = candidate.probability * 100;
  const evidence = [
    `유통 회전율 ${Math.round(candidate.turnover * 100).toLocaleString("ko-KR")}% · 발행주식수 대비 하루 거래량`,
    `시가총액 ${formatTradingAmount(candidate.marketCap, "USD")} · 거래대금 ${formatTradingAmount(candidate.dollarVolume, "USD")}`
  ];

  if (candidate.daysSinceLastRun === null) evidence.push("2년 안에 급등한 적이 없는 종목입니다");
  else if (candidate.daysSinceLastRun === 0) evidence.push("직전 거래일에 이미 급등했습니다 · 연속성 후보입니다");
  else evidence.push(`마지막 급등 ${candidate.daysSinceLastRun}일 전`);

  if (candidate.reverseSplitDays !== null) evidence.push(`${candidate.reverseSplitDays}일 전 액면병합 · 유통물량이 압축된 상태입니다`);

  if (candidate.catalyst) {
    const when = candidate.catalyst.days_ago === 0 ? "당일" : `${candidate.catalyst.days_ago}일 전`;

    evidence.push(`${when} SEC ${candidate.catalyst.form_type} · ${candidate.catalyst.label}`);
  }

  return {
    asOf,
    // Null when nothing was filed. The screen says so rather than staying
    // silent: "공시 없음" is information, given half of all surges have none.
    catalyst: candidate.catalyst
      ? {
        daysAgo: candidate.catalyst.days_ago,
        formType: candidate.catalyst.form_type,
        label: candidate.catalyst.label
      }
      : null,
    // Says which of the two things this row is: a stock that has not moved, or
    // one that moved and might keep going. Both belong on the list and they are
    // not read the same way.
    stage: candidate.daysSinceLastRun === null || candidate.daysSinceLastRun > 5 ? "대기" : "이미 급등",
    caution: `같은 조건의 종목 ${candidate.observations.toLocaleString("ko-KR")}건 중 ${percent.toFixed(1)}%가 급등했다는 뜻이며, 이 종목이 오른다는 뜻이 아닙니다.`,
    evidence,
    horizonDays,
    id: `us-surge-${candidate.symbol}`,
    market: "US",
    daysSinceLastRun: candidate.daysSinceLastRun,
    marketCapValue: candidate.marketCap,
    name: candidate.name ?? candidate.symbol,
    price: formatPrice(candidate.close),
    probability: candidate.probability,
    probabilityLabel: `${percent.toFixed(1)}%`,
    symbol: candidate.symbol,
    turnoverValue: candidate.turnover
  };
}

/**
 * Board-shaped candidates, empty rather than throwing.
 *
 * The tables behind this are filled by scripts run on one machine, so an
 * install that has never run them is the normal case rather than a fault. The
 * board renders an empty state and the rest of the screen is unaffected.
 */
export async function loadUsSurgeCandidateBoard(config, { limit = 12 } = {}) {
  if (!config.databaseUrl) return [];

  try {
    const { asOf, candidates, horizonDays } = await loadUsSurgeCandidates(config, { limit });

    return candidates.map((candidate) => toSurgeCandidateDto(candidate, { asOf, horizonDays }));
  } catch {
    return [];
  }
}
