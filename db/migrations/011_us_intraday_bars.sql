-- Five-minute bars across the whole trading day, including the hours the daily
-- bar throws away.
--
-- us_daily_bars is one row per session, which cannot answer when the move
-- happened. That turns out to matter more than it sounds: a US mover often
-- explodes at 04:00 ET — 17:00 in Seoul, hours before the opening bell —
-- carries into the regular session, and then changes hands again after the
-- close, when a different name takes over as the one everyone is watching.
-- None of that is visible in a single OHLC row.
--
-- Only surge days are stored, and only for the stocks that surged. Whole-market
-- minute data is a per-ticker request against a five-a-minute key, so covering
-- every stock every day is not on the table; covering the events themselves is,
-- and the question here is what a surge looks like from the inside.
--
-- Phases are Eastern, because that is what the exchange runs on:
--   pre      04:00-09:29   the premarket session
--   regular  09:30-15:59   the bell
--   post     16:00-20:00   after hours

CREATE TABLE IF NOT EXISTS us_intraday_bars (
  symbol text NOT NULL,
  session_date date NOT NULL,
  observed_at timestamptz NOT NULL,
  phase text NOT NULL,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  volume numeric,
  PRIMARY KEY (symbol, observed_at)
);

-- One stock's day in order, which is how every question here is asked.
CREATE INDEX IF NOT EXISTS us_intraday_bars_session_idx
  ON us_intraday_bars(symbol, session_date, observed_at);

-- Comparing what led during the bell with what led after it.
CREATE INDEX IF NOT EXISTS us_intraday_bars_phase_idx
  ON us_intraday_bars(session_date, phase);

-- Which (symbol, day) pairs have been fetched, including the ones that came
-- back empty, so a resumed run does not spend requests rediscovering them.
CREATE TABLE IF NOT EXISTS us_intraday_progress (
  symbol text NOT NULL,
  session_date date NOT NULL,
  bar_count integer NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, session_date)
);
