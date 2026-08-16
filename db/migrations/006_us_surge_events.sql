-- The labelled events: one row per stock per day it ran.
--
-- Derived from us_daily_bars rather than fetched, so it can be rebuilt whenever
-- the definition changes. It exists as a table rather than a view because the
-- filters below are the definition of the target — anything training against a
-- different set is answering a different question — and a table is something a
-- Python notebook can read without carrying the SQL around with it.
--
-- gain is measured to the DAY'S HIGH, not the close. These stocks routinely
-- double and give it all back in one session; measured on the close, most of
-- the events this table exists to study simply are not there.
--
-- Four things are excluded, in order of how much damage they do:
--
--   warrants and units   a warrant on a stock that ran also "ran", at 38% of
--                        raw hits by far the largest contaminant, and none of
--                        them are the common share anybody would be buying
--   reverse splits       a 1:10 leaves yesterday at $0.50 and today at $5.00,
--                        which reads as +900% and is not a move at all
--   sub-$0.10 prices     one tick is a double, so the percentage stops meaning
--                        anything
--   thin tape            under $1M traded, the move happened somewhere nobody
--                        could actually have participated

CREATE TABLE IF NOT EXISTS us_surge_events (
  symbol text NOT NULL,
  session_date date NOT NULL,
  prev_close numeric NOT NULL,
  open numeric,
  high numeric,
  close numeric,
  volume numeric,
  dollar_volume numeric,
  gain numeric NOT NULL,
  close_gain numeric,
  PRIMARY KEY (symbol, session_date)
);

-- Ranking a day's events, and counting events per session.
CREATE INDEX IF NOT EXISTS us_surge_events_session_idx
  ON us_surge_events(session_date, gain DESC);

-- Whether this name has run before, which is the whole premise of a watchlist.
CREATE INDEX IF NOT EXISTS us_surge_events_symbol_idx
  ON us_surge_events(symbol, session_date);
