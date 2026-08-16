-- Two years of US daily bars, for learning what a stock looked like the day
-- before it doubled.
--
-- market_price_samples records the KR session as it happens, one minute at a
-- time, because co-movement is an intraday relationship. This table is the
-- opposite: a single row per stock per day, backfilled from history, because
-- the question here is asked once a night rather than once a minute.
--
-- Prices are stored UNADJUSTED — exactly as they traded that day. Split
-- adjustment rewrites history onto today's share basis, which would report a
-- stock that traded at $0.40 in 2024 and later did a 1:20 reverse split as
-- having traded at $8.00. That population — sub-dollar names that reverse split
-- to keep their listing — is precisely the one being studied, so the price
-- filter has to see the price that was actually on the screen.
--
-- The cost of storing raw prices is that a reverse split looks like a surge:
-- a 1:10 leaves yesterday's close at $0.50 and today's open at $5.00, which
-- reads as +900%. us_splits exists so labelling can tell the two apart, and it
-- is not only a correction — a fresh reverse split compresses the float, which
-- is one of the setups worth flagging in its own right.

CREATE TABLE IF NOT EXISTS us_daily_bars (
  symbol text NOT NULL,
  session_date date NOT NULL,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  volume numeric,
  vwap numeric,
  trade_count integer,
  PRIMARY KEY (symbol, session_date)
);

-- One stock's history, for the run-up leading into an event.
CREATE INDEX IF NOT EXISTS us_daily_bars_symbol_idx
  ON us_daily_bars(symbol, session_date);

-- Every stock on one day, for scanning a session end to end.
CREATE INDEX IF NOT EXISTS us_daily_bars_session_idx
  ON us_daily_bars(session_date);

CREATE TABLE IF NOT EXISTS us_splits (
  symbol text NOT NULL,
  execution_date date NOT NULL,
  split_from numeric NOT NULL,
  split_to numeric NOT NULL,
  PRIMARY KEY (symbol, execution_date)
);

-- The backfill runs against a rate limit that makes a full pass take hours, so
-- it has to survive being interrupted. A day is recorded here once its bars are
-- committed; days the market was closed are recorded with bar_count 0 so the
-- next pass does not spend a request rediscovering the holiday.
CREATE TABLE IF NOT EXISTS us_backfill_progress (
  session_date date PRIMARY KEY,
  bar_count integer NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
