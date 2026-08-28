-- 매일 밤 스스로 채점하기 위한 표.
--
-- 지금까지는 신호가 맞았는지를 사람이 그때그때 확인했습니다. 그러면 기억에 남는
-- 것만 남고, 빗나간 것은 조용히 잊힙니다 -- 2026-08-27 VNRX가 조건에 맞아 알림이
-- 나갔고 마감 -20.8%였는데, 물어보지 않았으면 기록이 없었을 것입니다.

CREATE TABLE IF NOT EXISTS kr_signal_outcomes (
  kind text NOT NULL,               -- limit_pair | close_bet | leader_sector
  session_date date NOT NULL,
  symbol text NOT NULL,
  -- 신호가 났을 때의 상태. 나중에 구간을 나눠 볼 수 있게 그대로 남깁니다.
  detected_at timestamptz NOT NULL,
  tier text,
  theme text,
  entry_rate numeric,               -- 신호 시점 등락률
  leader_symbol text,
  leader_rate numeric,
  lead_gap numeric,
  -- 그날 그 뒤로 어떻게 됐나. 장중 되돌림이 이 매매의 실제 위험입니다.
  session_low numeric,
  session_high numeric,
  session_close numeric,
  -- 다음 날. 종가배팅과 짝꿍의 실측이 전부 이 구간이었습니다.
  next_open numeric,
  next_close numeric,
  market_next_open numeric,         -- 같은 날 시장 평균. 초과분을 내려면 필요합니다.
  scored_at timestamptz,
  PRIMARY KEY (kind, session_date, symbol)
);

CREATE INDEX IF NOT EXISTS kr_signal_outcomes_pending_idx
  ON kr_signal_outcomes (session_date) WHERE scored_at IS NULL;

-- 사전이 빠뜨린 테마를 우리가 덧붙이는 층.
--
-- **kr_theme_members를 고치지 않습니다.** 네이버 사전은 매일 다시 받아오므로 고쳐도
-- 덮어써지고, 무엇보다 우리가 넣은 것과 원본을 구분할 수 없게 됩니다. 별도 층으로
-- 두면 언제든 통째로 걷어낼 수 있습니다.
CREATE TABLE IF NOT EXISTS kr_theme_overlay (
  symbol text NOT NULL,
  theme_name text NOT NULL,
  -- 왜 넣었는지. 근거 없이 들어간 행이 없도록.
  reason text NOT NULL,
  evidence_days integer NOT NULL DEFAULT 0,
  added_at timestamptz NOT NULL DEFAULT now(),
  -- 사람이 승인했는가. 자동 발견은 false로 들어오고, 승인 전에는 화면이 쓰지 않습니다.
  approved boolean NOT NULL DEFAULT false,
  PRIMARY KEY (symbol, theme_name)
);

-- 같이 움직였는데 공유 테마가 없는 쌍. 며칠 반복되는지를 세다가 문턱을 넘으면
-- overlay 후보가 됩니다. 하루 같이 오른 것은 우연이고, 매주 같이 오르면 테마입니다.
CREATE TABLE IF NOT EXISTS kr_theme_candidates (
  left_symbol text NOT NULL,
  right_symbol text NOT NULL,
  seen_days integer NOT NULL DEFAULT 1,
  first_seen date NOT NULL,
  last_seen date NOT NULL,
  PRIMARY KEY (left_symbol, right_symbol)
);
