-- Intraday time series, kept per symbol rather than per board.
--
-- The board snapshot table holds one blob of the whole screen and keeps only
-- the newest row, which answers "what does the board look like now" and nothing
-- about how a stock got there. Grouping stocks by how they actually moved
-- together — 금호전기 pulling 금호건설 is a relationship no theme dictionary
-- contains — needs each symbol's own line through the day, so it is stored that
-- way from the start.
--
-- change_rate rather than price is the primary series: co-movement and lead-lag
-- are both computed on returns, and a rate is directly comparable across stocks
-- of any price. Turnover and volume ride along because leadership is read from
-- them.

CREATE TABLE IF NOT EXISTS market_price_samples (
  id bigserial PRIMARY KEY,
  market text NOT NULL,
  symbol text NOT NULL,
  name text,
  session_date date NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  change_rate numeric,
  turnover numeric,
  volume numeric,
  theme text,
  leader_rank integer,
  source text NOT NULL,
  UNIQUE (market, symbol, observed_at)
);

-- One stock's line through a session, for lead-lag against another stock.
CREATE INDEX IF NOT EXISTS market_price_samples_symbol_idx
  ON market_price_samples(symbol, observed_at);

-- Every stock at one moment, for clustering a session.
CREATE INDEX IF NOT EXISTS market_price_samples_session_idx
  ON market_price_samples(session_date, market, observed_at);
