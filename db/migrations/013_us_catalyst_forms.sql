-- The filing types that precede a surge, and a fourth axis on the rate table.
--
-- Measured over two years: of 6,687 surge days, half had an SEC filing in the
-- three days before. But frequency is not prediction — 8-K appears before 25%
-- of surges and is the single most common form on the tape, so its rate barely
-- clears the 0.48% base. What separates the forms below is what happened AFTER
-- they were filed:
--
--   424B4         4.19%   offering priced
--   F-3           2.95%   foreign shelf registration
--   CERT          2.66%   exchange listing approved
--   NT 10-Q       2.45%   quarterly report late
--   SCHEDULE 13D  2.39%   somebody crossed 5%
--   EFFECT        2.12%   registration went effective
--   S-1 / S-1/A   2.00%   registration filed
--   8-A12B        1.83%   new listing registered
--   425           1.31%   merger communication
--
-- The pattern is capital-markets machinery rather than news: offerings,
-- listings, stakes, mergers, and the notices a company files when it cannot
-- report on time. None of it is what a headline would call a catalyst.
--
-- It is also independent of turnover, which is why it earns a dimension rather
-- than a tiebreak. A filing lifts every band: 0.27% to 0.82% among stocks
-- trading under 5% of their shares, and 14.88% to 16.49% among those over 50%.

CREATE TABLE IF NOT EXISTS us_catalyst_forms (
  form_type text PRIMARY KEY,
  label text NOT NULL,
  measured_rate numeric
);

INSERT INTO us_catalyst_forms (form_type, label, measured_rate) VALUES
  ('424B4', '신주 발행 확정', 0.0419),
  ('F-3', '외국기업 증자 등록', 0.0295),
  ('CERT', '거래소 상장 승인', 0.0266),
  ('NT 10-Q', '분기보고서 지연', 0.0245),
  ('SCHEDULE 13D', '5% 지분 취득', 0.0239),
  ('F-1', '외국기업 상장 등록', 0.0216),
  ('EFFECT', '등록 효력 발생', 0.0212),
  ('S-1', '신주 등록', 0.0203),
  ('S-1/A', '신주 등록 정정', 0.0200),
  ('NT 10-K', '사업보고서 지연', 0.0194),
  ('8-A12B', '신규 상장 등록', 0.0183),
  ('F-1/A', '외국기업 상장 등록 정정', 0.0169),
  ('424B3', '증권신고서 보충', 0.0162),
  ('POS AM', '등록 사후 정정', 0.0161),
  ('425', '합병 관련 공시', 0.0131),
  ('424B5', '셸프 증자', NULL),
  ('S-3', '셸프 등록', NULL)
ON CONFLICT (form_type) DO NOTHING;

-- Filing presence joins the rate table as a fourth key. Rows are written at two
-- grains: with the filing bucket, and rolled up to 'any' — four dimensions
-- divides the sample thin enough that some cells stop meaning anything, and a
-- candidate landing in one of those falls back to the three-dimension rate
-- rather than to a number counted off a dozen observations.
ALTER TABLE us_surge_calibration
  DROP CONSTRAINT IF EXISTS us_surge_calibration_pkey;

ALTER TABLE us_surge_calibration
  ADD COLUMN IF NOT EXISTS filing_bucket text NOT NULL DEFAULT 'any';

ALTER TABLE us_surge_calibration
  ADD PRIMARY KEY (horizon_days, turnover_bucket, market_cap_bucket, recency_bucket, filing_bucket);
