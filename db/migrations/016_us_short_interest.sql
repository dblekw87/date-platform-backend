-- 공매도 잔고 — how much of a US stock was sold short, twice a month.
--
-- Measured 2026-08-18 over two years of surge history: a stock under a dollar
-- had fallen a median 22% in the month before it exploded, and 40% of them were
-- down 30% or more. Above five dollars the pattern inverts - 74% were already
-- rising. So the "beaten down, then it detonates" shape is real, and it belongs
-- to penny stocks specifically.
--
-- What that measurement cannot say is why. "Fell hard then surged" and "short
-- covering caused the surge" are different claims, and nothing in this database
-- could tell them apart. There is a reason to doubt the squeeze story too:
-- sub-dollar names are often hard or impossible to borrow, and a position
-- nobody could open cannot be squeezed out. The competing explanation is
-- dilution financing pushing the price down until the offering ends.
--
-- FINRA settles the question and charges nothing for it. Rule 4560 requires
-- members to report short positions in every equity, and the consolidated file
-- is served through api.finra.org with no key - about 22,000 rows per
-- settlement date, twice a month, roughly 150 bytes a row once the field list
-- is trimmed.
--
-- days_to_cover is the ratio the squeeze argument actually rests on: shares
-- short divided by average daily volume, or how long the shorts would need to
-- get out if they all left at once. Stored as reported rather than recomputed,
-- because the volume FINRA divided by is theirs and not ours.

CREATE TABLE IF NOT EXISTS us_short_interest (
  symbol text NOT NULL,
  settlement_date date NOT NULL,
  short_quantity numeric,
  average_daily_volume numeric,
  days_to_cover numeric,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, settlement_date)
);

-- Every question here starts from a surge day and looks backwards for the most
-- recent reading, so the symbol comes first and the date descends under it.
CREATE INDEX IF NOT EXISTS us_short_interest_symbol_idx
  ON us_short_interest (symbol, settlement_date DESC);

-- And the backfill asks which settlement dates it already holds.
CREATE INDEX IF NOT EXISTS us_short_interest_settlement_idx
  ON us_short_interest (settlement_date);
