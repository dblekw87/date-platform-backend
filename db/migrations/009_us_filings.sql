-- Every SEC filing of the past two years, so a surge can be asked what it was
-- filed against.
--
-- The candidate list can say which stocks are combustible. It cannot say what
-- lights them, and that answer is not in the price series: a stock doubles
-- because a drug was accepted for review, a contract was signed, a merger was
-- announced, or twelve million new shares were registered. All four arrive as
-- filings, hours before or after the tape moves.
--
-- Sourced from EDGAR's quarterly full indexes rather than per-company lookups.
-- One file lists every filing made in a quarter by every registrant, which is
-- nine requests for two years against sixteen thousand companies.
--
-- Stored by CIK, like us_share_counts, because a company keeps its CIK through
-- the ticker changes and reverse splits that are themselves part of the story.

CREATE TABLE IF NOT EXISTS us_filings (
  cik integer NOT NULL,
  accession text NOT NULL,
  form_type text NOT NULL,
  filed_date date NOT NULL,
  company_name text,
  PRIMARY KEY (cik, accession)
);

-- What a company filed around a given day — the join every attribution makes.
CREATE INDEX IF NOT EXISTS us_filings_cik_date_idx
  ON us_filings(cik, filed_date);

-- Which form types cluster on surge days, counted across all issuers.
CREATE INDEX IF NOT EXISTS us_filings_form_idx
  ON us_filings(form_type, filed_date);
