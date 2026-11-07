-- 그림자 매매 장부. 주문은 내지 않고, 규칙대로 샀다면 무슨 값에 사고팔았을지를 적습니다.
--
-- 2026-11-08 사용자: 시스템 트레이딩으로 넘어가기 전에 기계가 사람보다 나은지 재 보기로.
-- 기존 채점(kr_signal_outcomes·close-bet-log)은 "종가에 반드시 샀고 익일 시가에 팔았다"고
-- 가정합니다. 실제 주문은 그렇지 않습니다:
--
--   상한가에 잠긴 종목은 종가에 거의 안 채워집니다(마감 체결량 = 매수잔량의 6%)
--   청산은 시가가 아니라 09:05~09:10입니다
--   손절(대형 −2%, 중소형 −3%)과 비용(세금·수수료)이 빠집니다
--
-- 이 표는 그 가정을 걷어낸 값을 적습니다. strategy로 전략을 나눠 두어 다음 전략도
-- 같은 장부에서 같은 방식으로 채점합니다.
CREATE TABLE IF NOT EXISTS shadow_trades (
  strategy text NOT NULL,          -- close_bet | ...
  session_date date NOT NULL,      -- 진입한 장
  symbol text NOT NULL,
  name text,
  tier text,
  market_cap numeric,
  material text,                   -- 고른 이유(알림의 재료 줄)
  -- 고른 순간. 15:20 종가 단일가 직전의 장중 값입니다.
  picked_at timestamptz NOT NULL DEFAULT now(),
  pick_price numeric,
  pick_rate numeric,
  locked boolean NOT NULL DEFAULT false,   -- 고른 순간 상한가에 잠겨 매도호가가 없었나
  bid_queue numeric,                       -- 잠겼다면 그 앞에 선 매수잔량
  -- 체결. 종가 단일가에 넣었다면.
  entry_price numeric,             -- 정규장 종가
  entry_rate numeric,
  filled boolean,                  -- NULL = 아직 모름
  fill_note text,
  stop_pct numeric,                -- 손절 폭(%) -- 시총 1조 이상 2, 아니면 3
  -- 청산. 다음 장 09:05~09:10.
  exit_date date,
  exit_at timestamptz,
  exit_price numeric,
  exit_open numeric,               -- 그날 시가
  exit_low numeric,                -- 청산 시각까지의 저가 -- 손절에 닿았는지 봅니다
  PRIMARY KEY (strategy, session_date, symbol)
);

CREATE INDEX IF NOT EXISTS shadow_trades_open_idx
  ON shadow_trades (strategy, session_date) WHERE exit_price IS NULL;
