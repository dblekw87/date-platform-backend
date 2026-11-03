-- 신규상장 첫날 거래원(증권사 창구) 상위 5곳, 10분마다.
--
-- 2026-11-03 사용자 요청입니다: 신규주는 기관·외국인이 언제 파는지 장중에 볼 수가
-- 없다. 투자자별은 장 마감 뒤에야 확정되고, 장중 기관 추정은 부호부터 틀리며,
-- 첫날 프로그램매매는 빈 응답입니다. 거래원은 장중에 나옵니다 -- 래블업 첫날
-- 주관사 NH투자증권 창구 순매도 약 150만 주가 기관 확정 순매도 149만 주와 같았습니다.
-- 공모 물량이 몇 시에 나왔는지를 사후에 보려고 쌓습니다. 알림은 없습니다.

CREATE TABLE IF NOT EXISTS kr_listing_brokers (
  symbol text NOT NULL,
  session_date date NOT NULL,
  observed_at timestamptz NOT NULL,
  side text NOT NULL,            -- 'sell' | 'buy'
  rank smallint NOT NULL,        -- 1..5
  broker_no text,
  broker_name text,
  qty numeric,                   -- 그 시각까지 누적 수량
  share numeric,                 -- 전체 거래량 대비 %
  is_global boolean,             -- 외국계 창구
  global_sell_qty numeric,       -- 외국계 합계(그 시각까지)
  global_buy_qty numeric,
  PRIMARY KEY (symbol, session_date, observed_at, side, rank)
);
