-- Registered industry for a US company: the floor beneath the curated theme map.
--
-- The domestic side has had one since DART. When the curated map stays silent,
-- the KSIC code registered with the regulator answers instead, on the reasoning
-- that a real sector beats 미분류. The US side had no equivalent at all, so a
-- leader the map did not name fell straight through to 개별 종목 — 14 of 30 US
-- leaders on 2026-08-14 against 0 of 30 domestic ones. Applied Optoelectronics
-- rose 15.5% on a day semiconductors led the board and sat outside the group it
-- plainly belongs to, because nothing had ever been asked what business it is in.
--
-- SEC assigns every registrant an SIC code, which is the same kind of answer
-- KSIC gives and costs nothing to read: us_tickers already carries the CIK, and
-- data.sec.gov/submissions serves the code without an API key.
--
-- Keyed by CIK rather than by symbol because the industry belongs to the company
-- and not to the security. Tickers change and a company can list several
-- classes; the registration behind them does not move.
--
-- Only the code is stored, never the theme mapped from it. The domestic map
-- learned this the hard way — caching the mapped answer froze every lookup
-- against the rules in force the day it ran, so correcting a rule left the wrong
-- theme in place until the cache was deleted by hand.

CREATE TABLE IF NOT EXISTS us_company_industry (
  cik integer PRIMARY KEY,
  sic text,
  sic_description text,
  checked_at timestamptz NOT NULL DEFAULT now()
);

-- Companies that answered without an SIC are kept as rows so they are not asked
-- again on every board build. This finds the ones still worth retrying, without
-- making the far larger set of successful lookups pay for the index.
CREATE INDEX IF NOT EXISTS us_company_industry_missing_idx
  ON us_company_industry(checked_at)
  WHERE sic IS NULL;
