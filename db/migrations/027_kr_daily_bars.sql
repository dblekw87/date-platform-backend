-- 국내 일봉 — 종가배팅을 재기 위한 표.
--
-- 종가배팅은 "오늘 종가에 사서 내일 시가에 판다"입니다. 그러니 필요한 값은 딱
-- 두 개, 전일 종가와 당일 시가입니다. 우리 분봉은 2026-08-18에 시작해서 밤이
-- 세 개뿐이고, 세 밤의 갭상승 확률은 43% / 71% / 30%였습니다 -- 이 폭 안에서는
-- 어떤 조건도 좋아 보이거나 나빠 보이게 만들 수 있어서 아무것도 판정할 수 없습니다.
--
-- 네이버 일봉은 종목당 1.6년치를 한 번의 요청으로 줍니다(398거래일, 25KB, 0초).
-- 600종목이면 24만 종목일이 되고, 그 정도면 "이 조건일 때 갭상승 확률이 밤 평균보다
-- 높은가"를 밤을 통제한 채로 물을 수 있습니다.
--
-- 밤 자체는 예측하지 않습니다. 미국과 이란이 전쟁을 하면 코스피는 다 떨어지고 그건
-- 어느 종목을 골랐든 마찬가지입니다. 그래서 측정 대상은 갭의 절대값이 아니라 **그날
-- 밤 평균 대비 초과분**입니다. 그렇게 재면 매크로가 양변에서 상쇄되고 남는 것이
-- 종목 선택의 몫입니다.
--
-- 시가가 있는 표는 이것뿐입니다. market_price_samples에는 등락률만 있고 그건 전일
-- 종가 기준이라, 09:00 첫 표본이 갭의 근사치는 되지만 순위권 밖 종목에는 그 표본이
-- 아예 없습니다. 일봉은 전 종목에 대해 빠짐이 없습니다.
--
-- 외국인소진율도 같이 옵니다. 요청 하나에 딸려 오는 값이라 버릴 이유가 없고,
-- 수급이 갭에 미치는 영향을 나중에 물어볼 수 있습니다.

CREATE TABLE IF NOT EXISTS kr_daily_bars (
  symbol text NOT NULL,
  session_date date NOT NULL,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  volume numeric,
  foreign_ratio numeric,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, session_date)
);

-- 한 종목의 시간축 — 어제 종가와 오늘 시가를 이어 붙이는 축입니다.
CREATE INDEX IF NOT EXISTS kr_daily_bars_symbol_idx
  ON kr_daily_bars (symbol, session_date DESC);

-- 하루 전체 — 그날 밤의 평균 갭을 구하는 축입니다. 종목별 초과분은 이 값을
-- 빼야 나오므로, 이 방향으로도 읽습니다.
CREATE INDEX IF NOT EXISTS kr_daily_bars_session_idx
  ON kr_daily_bars (session_date DESC, symbol);
