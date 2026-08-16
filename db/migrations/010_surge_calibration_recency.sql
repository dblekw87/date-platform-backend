-- Adds "how long since this stock last ran" as a third axis.
--
-- It was briefly a filter. A list ranked without it filled with names that had
-- already gone — half of one twelve-name list, including a stock up 321% that
-- same session — because the turnover that ranks a candidate is also what a
-- surge leaves behind. Cutting them out fixed that and created a worse problem:
-- those are the highest-probability names on the board. Measured over 500
-- sessions, in the 20%+ turnover pool:
--
--   ran today            20.4%
--   ran 1-5 days ago     15.5%
--   ran 6-20 days ago     8.1%
--   ran 21-90 days ago    8.4%
--   ran over 90 days ago  8.3%
--   never ran             6.2%
--
-- Deleting the top two rows throws away the best odds on the screen, and a
-- stock that ran last week can absolutely run again — a reverse split or a
-- merger does not care what the chart did on Tuesday. But the two groups are
-- not the same product: one is a continuation, the other is a stock that has
-- not moved yet, and the reader is entitled to know which is which.
--
-- So it becomes a dimension. The rate is measured per recency band, the band
-- travels with the candidate, and the screen can label rather than hide.

ALTER TABLE us_surge_calibration
  DROP CONSTRAINT IF EXISTS us_surge_calibration_pkey;

ALTER TABLE us_surge_calibration
  ADD COLUMN IF NOT EXISTS recency_bucket text NOT NULL DEFAULT 'Z 이력없음';

ALTER TABLE us_surge_calibration
  ADD PRIMARY KEY (horizon_days, turnover_bucket, market_cap_bucket, recency_bucket);
