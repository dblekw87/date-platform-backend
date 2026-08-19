-- 투자자별 매매동향 — who bought, which the price series cannot say.
--
-- Everything collected so far answers what happened: price, change, turnover,
-- volume. None of it answers who, and on 2026-08-19 that was the question.
-- 바이오니아 went +24% at 09:03, fell to about 14%, and closed limit-up, and the
-- reading offered for it - foreigners dumping into program buying - is one this
-- database could not confirm or contradict.
--
-- KIS serves it free and without extra setup, in two shapes with different
-- limits, both measured before this table existed:
--
--   FHKST01010900  개인·외국인·기관 net, by day. Today's row is blank until the
--                  session settles, so it is collected after the close.
--   FHPPG04650100  program trading, by time within the day. Cumulative net, and
--                  the only intraday view of flow there is.
--
-- Daily is what this table holds. One request per symbol means the intraday
-- program series cannot be swept across hundreds of names on a five-a-second
-- budget, and the daily breakdown is the half that names the actors.
--
-- Quantities are shares and the _amount columns are won, both as reported.
-- Negative is net selling.

CREATE TABLE IF NOT EXISTS kr_investor_flow (
  symbol text NOT NULL,
  session_date date NOT NULL,
  close numeric,
  individual_qty numeric,
  foreign_qty numeric,
  institution_qty numeric,
  individual_amount numeric,
  foreign_amount numeric,
  institution_amount numeric,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, session_date)
);

-- Read from a surge day backwards: "who was selling this the week before it
-- ran", so the symbol leads and the date descends beneath it.
CREATE INDEX IF NOT EXISTS kr_investor_flow_symbol_idx
  ON kr_investor_flow (symbol, session_date DESC);

CREATE INDEX IF NOT EXISTS kr_investor_flow_session_idx
  ON kr_investor_flow (session_date);
