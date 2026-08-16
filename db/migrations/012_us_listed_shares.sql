-- Share counts for the security that actually trades.
--
-- us_share_counts comes from SEC XBRL, which is authoritative for a US filer
-- and wrong by orders of magnitude for a foreign one. dei:EntityCommonStock-
-- SharesOutstanding reports ORDINARY shares; what changes hands on Nasdaq is an
-- ADS representing some multiple of them. Steakholder Foods filed 5,438,836,659
-- shares, which priced a micro-cap at $15.7 billion — 7,800 times its real
-- $2.0 million — and buried a stock that has run seven times in two years in
-- the bucket reserved for mega caps, where the measured surge rate is 0.03%.
--
-- It is not one bad row. Of the 200 ADRs trading on 2026-08-13, 148 (74%)
-- computed to over $2 billion. ADRs are where the Chinese and Israeli micro
-- caps list, which is to say most of the population this whole model exists to
-- find, and all of it was invisible.
--
-- Dated like everything else here, because the exchange listing is what reverse
-- splits and ratio changes act on, and those are the events that matter most to
-- the stocks in question.

CREATE TABLE IF NOT EXISTS us_listed_shares (
  symbol text NOT NULL,
  as_of date NOT NULL,
  shares numeric,
  market_cap numeric,
  PRIMARY KEY (symbol, as_of)
);

-- The count in force on a given day is the newest one recorded before it.
CREATE INDEX IF NOT EXISTS us_listed_shares_symbol_idx
  ON us_listed_shares(symbol, as_of DESC);
