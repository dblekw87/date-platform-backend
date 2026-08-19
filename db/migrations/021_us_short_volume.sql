-- FINRA 일별 공매도 거래량 — 격주 공매도 잔고와는 다른 것.
--
-- us_short_interest holds the settled short position, published twice a month
-- and already stale when it arrives. This is the other half: how much of each
-- day's volume was sold short, published every morning for the whole market.
--
-- Measured 2026-08-19 against 2026-08-18's file: 12,261 symbols, no key, no
-- quota. Columns are as FINRA writes them, including the fractional volumes -
-- the file carries decimals because it sums across venues.
--
-- Why it is worth the table: [[us-short-squeeze-finding]] concluded penny surges
-- are not short covering, but that was measured against the biweekly position.
-- Whether the short *flow* rises into a surge is a different question and this
-- is the only free series that can answer it.

CREATE TABLE IF NOT EXISTS us_short_volume (
  symbol text NOT NULL,
  session_date date NOT NULL,
  short_volume numeric,
  short_exempt_volume numeric,
  total_volume numeric,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, session_date)
);

-- Read from a surge day backwards, the same way the flow tables are.
CREATE INDEX IF NOT EXISTS us_short_volume_symbol_idx
  ON us_short_volume (symbol, session_date DESC);

CREATE INDEX IF NOT EXISTS us_short_volume_session_idx
  ON us_short_volume (session_date);
