-- 프로그램매매 — 장중에 볼 수 있는 유일한 수급.
--
-- kr_investor_flow(개인·외국인·기관)는 장이 끝나고 정산된 뒤에야 채워집니다. 그래서
-- "지금 이 종목에 누가 들어오고 있나"는 장중에 답할 수 없었고, 2026-08-20에 SOX와
-- 국내 반도체의 관계를 쟀을 때도 가격 반응만 재고 프로그램 매매 자체는 못 봤습니다.
--
-- KIS FHPPG04650100이 그 빈칸을 메웁니다. 종목별로 그날의 시각별 누적 프로그램
-- 순매수를 돌려줍니다. 개장 전에는 0행이고 장이 열리면 채워집니다.
--
-- 누적값이므로 두 시각의 차이가 그 구간에 들어온 양입니다. icdc 컬럼은 KIS가 계산해
-- 준 직전 대비 증감으로, 우리가 다시 빼지 않아도 되게 그대로 보관합니다.

CREATE TABLE IF NOT EXISTS kr_program_trade (
  symbol text NOT NULL,
  session_date date NOT NULL,
  observed_time text NOT NULL,
  price numeric,
  change_rate numeric,
  accumulated_volume numeric,
  net_qty numeric,
  net_amount numeric,
  buy_qty numeric,
  sell_qty numeric,
  net_qty_change numeric,
  net_amount_change numeric,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, session_date, observed_time)
);

-- Read as "how did program flow move through this stock today", so the symbol
-- leads and time runs forward beneath it.
CREATE INDEX IF NOT EXISTS kr_program_trade_symbol_idx
  ON kr_program_trade (symbol, session_date, observed_time);

CREATE INDEX IF NOT EXISTS kr_program_trade_session_idx
  ON kr_program_trade (session_date);
