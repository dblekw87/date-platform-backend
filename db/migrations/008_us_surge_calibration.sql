-- Measured surge rates by bucket, so a candidate can carry a probability
-- instead of a score.
--
-- A score is only good for sorting. It cannot say whether the name at the top
-- is a coin flip or a long shot, and a list that cannot say so invites reading
-- rank one as a prediction. These rows are counted off the same two years the
-- list is built from: how many stock-days landed in a bucket, and how many of
-- them were followed by a +50% session inside the window.
--
-- Buckets rather than a fitted model because the relationship is not smooth and
-- the honest answer is a frequency. Turnover against share count is the axis
-- that separates 0.19% from 12.9%; market cap adds most of what is left.
--
-- The rate is a base rate, not a forecast for the specific stock. Every name in
-- a bucket carries the same number, which is exactly as much as the data
-- supports.

CREATE TABLE IF NOT EXISTS us_surge_calibration (
  horizon_days integer NOT NULL,
  turnover_bucket text NOT NULL,
  market_cap_bucket text NOT NULL,
  observations integer NOT NULL,
  surges integer NOT NULL,
  rate numeric NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (horizon_days, turnover_bucket, market_cap_bucket)
);
