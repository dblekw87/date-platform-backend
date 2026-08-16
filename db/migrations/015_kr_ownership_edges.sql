-- 지분 그래프 — which companies a listed domestic company owns a piece of.
--
-- The board can say a stock rose and which theme it rose with. It cannot say
-- why, and one whole class of reason is invisible to everything it reads:
-- the driver is not the company, it is something the company owns.
--
-- SK텔레콤 on 2026-08-16 is the case that prompted this. It rose on 앤트로픽
-- 지분 가치 — a stake in a private American company. That fact is in no price
-- series, no KSIC code, and no headline the catalyst rules can classify, and it
-- is not derivable from co-movement either, because the thing that moved is not
-- listed and has no price to co-move with. It is a fact about ownership, and
-- the only place it lives is the annual report.
--
-- DART serves it free: 타법인 출자현황 (otrCprInvstmntSttus) lists every equity
-- stake a filer holds, with the acquisition date, the percentage, the book value
-- and — the field that matters most — the year's revaluation. SK텔레콤's
-- Anthropic row reads 0.3%, 1조 3,762억 book value, up 1조 1,838억 on the year.
-- A whole-market pass costs about 3,900 requests against a 20,000/day quota and
-- runs in minutes.
--
-- Read in both directions:
--   holder → investees   why this stock moved, when the reason is what it owns
--   investee → holders   which listed names carry exposure to a private company
--                        in the news, which is the direction a trade is made on
--
-- Annual data. A row changes once a year when the 사업보고서 lands, so this is
-- backfilled by script and never inside a board build.

CREATE TABLE IF NOT EXISTS kr_ownership_edges (
  holder_symbol text NOT NULL,
  business_year integer NOT NULL,
  -- DART identifies the investee by name only — no code, no ticker, and the
  -- spelling is whatever the filer typed: "Anthropic", "SK텔링크㈜",
  -- "SK Japan Inc.(舊 SK Telecom Japan)". So the name is the key, and matching
  -- it to a listed symbol is a separate, best-effort step below.
  investee_name text NOT NULL,
  holder_corp_code text NOT NULL,
  investee_symbol text,
  first_acquired_on date,
  purpose text,
  stake_pct numeric,
  book_value numeric,
  -- The year's revaluation. This is the column that finds a story: a stake whose
  -- carrying value jumped is a stake the market is about to notice, and it
  -- ranks the holder's reasons without anyone writing a rule about them.
  valuation_change numeric,
  investee_total_assets numeric,
  investee_net_profit numeric,
  receipt_no text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (holder_symbol, business_year, investee_name)
);

-- The investee → holders direction, which is the one a trade is made on.
CREATE INDEX IF NOT EXISTS kr_ownership_edges_investee_idx
  ON kr_ownership_edges(investee_name);

-- Ranking a holder's stakes by what moved, and finding the market's biggest
-- revaluations across every filer at once.
CREATE INDEX IF NOT EXISTS kr_ownership_edges_valuation_idx
  ON kr_ownership_edges(business_year, valuation_change DESC NULLS LAST);
