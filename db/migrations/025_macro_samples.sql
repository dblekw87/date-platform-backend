-- 매크로 시계열 — 지수, BTC, 금, 유가, 환율, 미 국채.
--
-- 보드는 이 값들을 처음부터 매번 받아 화면에 뿌리고 있었는데 한 행도 저장하지
-- 않았습니다. 그래서 2026-08-22에 "비트코인이 왜 올랐나"를 물었을 때, 우리 DB에는
-- BTC 가격이 단 하나도 없어서 CoinGecko에 다시 물어봐야 했습니다. 종목은 1분마다
-- 57만 행을 쌓아두면서 그 종목들이 움직인 배경은 아무것도 남기지 않은 셈입니다.
--
-- 이게 없으면 못 하는 것들이 구체적입니다.
--
--   * 지수 대비 초과수익 — 코스피가 3% 오른 날 3% 오른 종목은 주도주가 아닙니다.
--     시장 국면 이유 생성기가 과거 날짜에 대해 재현되지 않는 것도 같은 이유입니다.
--   * BTC → 국내 코인주 전이 시차 — 우리기술투자가 두나무 지분으로 움직인다면
--     BTC가 먼저 움직이고 몇 분 뒤에 따라오는지가 측정 가능한 질문이 됩니다.
--   * 금·은·달러와 함께 움직였는지 — 2026-08-20 BTC 급등은 코인 고유 재료가 아니라
--     재무부 국채 매입 확대에 따른 통화가치 훼손 트레이드였고, 그 판정의 근거는
--     "금도 같이 올랐다"였습니다. 지금은 그 문장을 뉴스 제목으로만 확인할 수 있습니다.
--
-- 추가 API 호출은 0입니다. loadMacroSnapshot이 이미 매 보드 빌드마다 받아오는 값을
-- 그대로 적을 뿐입니다.
--
-- 값은 numeric으로 따로 저장합니다. 화면용 문자열("2,540.11", "-1.40%")은 천 단위
-- 쉼표와 퍼센트 기호가 붙어 있어 그대로 두면 나중에 전부 다시 파싱해야 합니다.

CREATE TABLE IF NOT EXISTS macro_samples (
  id bigserial PRIMARY KEY,
  snapshot_id text NOT NULL,
  label text NOT NULL,
  market text NOT NULL,
  instrument_type text NOT NULL,
  symbol text NOT NULL,
  value numeric,
  change_rate numeric,
  observed_at timestamptz NOT NULL,
  source text NOT NULL,
  UNIQUE (snapshot_id, observed_at)
);

-- 하나의 계열을 시간순으로 — 리드랙과 전이 시차를 재는 축입니다.
CREATE INDEX IF NOT EXISTS macro_samples_series_idx
  ON macro_samples (snapshot_id, observed_at DESC);

-- 한 시점의 전부 — "그날 금과 BTC가 같이 올랐나"를 한 번에 봅니다.
CREATE INDEX IF NOT EXISTS macro_samples_observed_idx
  ON macro_samples (observed_at DESC);
