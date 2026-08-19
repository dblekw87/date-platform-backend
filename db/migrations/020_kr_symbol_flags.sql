-- 시장 지정 — 관리종목, 투자주의·경고·위험, 거래정지, 정리매매, 단기과열.
--
-- The board carried a 주의 tab that could never fill, because nothing collected
-- said which stocks are designated. It turned out KIS was already sending it:
-- inquire-price returns the whole set on every call and the mapping threw all
-- of it away. Measured 2026-08-19 — SHD came back mrkt_warn_cls_code=01
-- (투자주의) and mang_issu_cls_code=Y (관리종목), 좋은사람들 also 관리종목,
-- 삼성전자 clean.
--
-- The collector already quotes every symbol it has seen, so this costs no extra
-- request. One row per symbol per day: a designation is a state of the listing
-- rather than of the tick, and storing it per tick would repeat it 190 times.
--
--   mrkt_warn_cls_code  00 없음 · 01 투자주의 · 02 투자경고 · 03 투자위험
--   iscd_stat_cls_code  51 관리종목 · 52 투자위험 · 53 투자경고 · 54 투자주의
--                       55 신용가능 · 57 증거금100% · 58 거래정지 · 59 단기과열

CREATE TABLE IF NOT EXISTS kr_symbol_flags (
  symbol text NOT NULL,
  session_date date NOT NULL,
  market_warn text,
  status_code text,
  managed boolean,
  halted boolean,
  liquidation boolean,
  short_overheated boolean,
  investment_caution boolean,
  credit_allowed boolean,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, session_date)
);

-- Read as "which of today's names are designated", so the date leads.
CREATE INDEX IF NOT EXISTS kr_symbol_flags_session_idx
  ON kr_symbol_flags (session_date, symbol);
