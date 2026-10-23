-- 국내 공매도와 대차, 종목별 일별.
--
-- 2026-10-23 사용자 가설입니다. 삼성E&A 대차잔고가 +27% 오르는 이틀 동안 668만주에서
-- 꿈쩍하지 않는 걸 토스 화면으로 보고 "소형주는 공매도·대차로 예측 가능할 것 같다"고
-- 했습니다. 미국에서는 공매도 수준이 역방향이고 평소 대비 급변만 살아남았으니
-- (us_short_volume), 국내도 같은 축으로 재려면 먼저 표가 있어야 합니다.
--
-- 둘 다 KIS입니다. 공매도(FHPST04830000)는 장이 끝나면 당일치가 바로 나오고 가격은
-- 수정주가, 대차(HHPST074500C0)는 저녁에 나오고(10/23 23시에 당일치 확인) 가격은 비수정입니다. 그래서 가격은
-- 공매도 쪽에만 둡니다.
--
-- 2023-11-06 ~ 2025-03-30 공매도 전면 금지 기간은 0으로 옵니다. 그 구간을 "공매도 없음"
-- 으로 읽으면 안 되므로 측정 창은 2025-03-31부터입니다.

CREATE TABLE IF NOT EXISTS kr_short_sale (
  symbol text NOT NULL,
  session_date date NOT NULL,
  close numeric,
  volume numeric,
  short_qty numeric,
  short_amount numeric,
  -- 거래량 대비 %. KIS가 계산해 준 값을 그대로 둡니다.
  short_ratio numeric,
  avg_price numeric,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, session_date)
);

CREATE INDEX IF NOT EXISTS kr_short_sale_session_idx ON kr_short_sale (session_date);

CREATE TABLE IF NOT EXISTS kr_stock_lending (
  symbol text NOT NULL,
  session_date date NOT NULL,
  new_qty numeric,
  repaid_qty numeric,
  change_qty numeric,
  balance_qty numeric,
  -- 백만원.
  balance_amount numeric,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, session_date)
);

CREATE INDEX IF NOT EXISTS kr_stock_lending_session_idx ON kr_stock_lending (session_date);
