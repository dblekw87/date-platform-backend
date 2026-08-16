-- Share counts and the ticker universe, both stored as of a date.
--
-- Everything here exists to answer one question the price series cannot: how
-- many shares were there. A stock runs 500% because there is nothing left to
-- sell, so the share count is not a detail about the company, it is the
-- mechanism — and dividing it into the price gives the market cap that decides
-- whether a move is even possible.
--
-- Both tables are dated because the current value is the wrong one. A company
-- that has issued stock every quarter for two years has a share count today
-- that says nothing about what it was on the morning it doubled, and using
-- today's number to describe that morning is reading the answer off the back of
-- the page. Every join has to reach for the row that was true at the time.

-- The point-in-time universe: which symbols existed on a date, what kind of
-- instrument each was, and which SEC filer it belongs to.
--
-- `type` replaces guessing from the symbol. A five-letter ticker ending in W is
-- usually a warrant, but 'usually' put roughly six thousand warrant days into a
-- first pass at labelling; the exchange's own classification does not guess.
CREATE TABLE IF NOT EXISTS us_tickers (
  symbol text NOT NULL,
  as_of date NOT NULL,
  cik integer,
  name text,
  type text,
  primary_exchange text,
  active boolean,
  PRIMARY KEY (symbol, as_of)
);

-- Resolving an event's symbol to its filer.
CREATE INDEX IF NOT EXISTS us_tickers_symbol_idx
  ON us_tickers(symbol, as_of DESC);

CREATE INDEX IF NOT EXISTS us_tickers_cik_idx
  ON us_tickers(cik, as_of DESC);

-- Shares outstanding as reported on the cover of each 10-Q and 10-K, keyed by
-- filer rather than by symbol because a company keeps its CIK across ticker
-- changes and reverse splits — exactly the events that break symbol-keyed
-- history, and exactly the companies being studied.
CREATE TABLE IF NOT EXISTS us_share_counts (
  cik integer NOT NULL,
  period_end date NOT NULL,
  shares numeric NOT NULL,
  accession text,
  PRIMARY KEY (cik, period_end)
);

-- The count in force on a given day is the newest one filed before it.
CREATE INDEX IF NOT EXISTS us_share_counts_cik_idx
  ON us_share_counts(cik, period_end DESC);
