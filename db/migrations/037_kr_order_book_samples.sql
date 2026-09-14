-- 상한가 근처 종목의 호가 잔량. 상따 연구용.
--
-- 2026-09-14 실측: 24%에 닿은 소형주가 종가까지 잠기는 비율은 34%이고, 우리가 가진
-- 변수(가격 경로·거래대금·시각·시총·공시)를 다 써도 40%대에서 멈춘다. 상따를 하는
-- 사람이 보는 것은 상한가 매수잔량과 매도호가 소진인데 그 열이 없었다. 24% 위 종목만
-- 1분마다 찍는다. 아직 어떤 화면도 알림도 읽지 않는다 -- 2~4주 뒤 잔량이 잠김을
-- 가르는지 잰 다음에 쓴다.
CREATE TABLE IF NOT EXISTS kr_order_book_samples (
  symbol text NOT NULL,
  session_date date NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  change_rate numeric,            -- 그 틱의 등락률(시세 표본에서)
  price numeric,
  best_ask numeric,               -- 상한가에 잠기면 NULL
  best_bid numeric,
  ask_qty1 numeric,
  bid_qty1 numeric,               -- 상한가 매수잔량이 여기 온다
  ask_qty_top3 numeric,
  bid_qty_top3 numeric,
  total_ask_qty numeric,
  total_bid_qty numeric,
  PRIMARY KEY (symbol, observed_at)
);
CREATE INDEX IF NOT EXISTS kr_order_book_samples_session_idx ON kr_order_book_samples (session_date, symbol, observed_at);
