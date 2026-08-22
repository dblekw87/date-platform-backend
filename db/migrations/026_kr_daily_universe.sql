-- 국내 전 종목 일별 시세 — 순위 밖에서 벌어진 일을 보기 위한 표.
--
-- 수집 모집단은 KIS 랭킹 상위 30개와 짝꿍 후보뿐입니다. 2026-08-21에 오가닉티코스메틱과
-- 네오이뮨텍이 각각 +29.89%, +29.84%로 토스 급상승 2위와 5위에 올랐는데 우리 DB에는
-- 두 종목의 행이 **하나도** 없습니다. 거래대금이 작아 어느 랭킹에도 못 들어왔기
-- 때문입니다. 코미코는 11:10까지 순위에 있다가 빠져서 종가를 모릅니다.
--
-- 이것이 [[ranking-keyhole-finding]]에 적어둔 열쇠구멍입니다. 순위권 안에서만 보이면
-- 움직임의 시작과 끝이 없고, 짝꿍매매에서 "따라간 쪽이 얼마나 따라갔나"를 끝까지
-- 추적할 수 없습니다. 1분 표본은 여전히 순위권만 받지만, 하루 한 번 전 종목의
-- 종가·거래대금·시총을 남겨두면 적어도 그날 무슨 일이 있었는지는 사후에 복원됩니다.
--
-- 출처는 네이버 모바일 증권의 시가총액 목록입니다. KRX 공식 Open API 키는 이
-- 엔드포인트들에 401을 돌려주고(엔드포인트별 승인이 따로 필요), data.krx.co.kr의
-- 웹 엔드포인트는 세션 쿠키를 요구하며 LOGOUT을 반환합니다. 네이버 쪽은 키 없이
-- 100종목씩 44페이지, 하루 한 번이면 충분합니다.
--
-- trade_halted가 여기 있는 이유. 같은 응답이 종목마다 거래정지 여부를 함께 주는데
-- (측정일 기준 4,300종목 중 138종목), 이건 다른 어떤 소스에서도 무료로 얻지 못하던
-- 정보입니다. 거래정지는 시총과 함께 봐야 뜻이 생깁니다 — 한화 5.9조가 정지된 것과
-- 삼부토건 797억이 정지된 것은 같은 사건이 아닙니다.
--
-- 금액 단위는 원입니다. 네이버는 거래대금을 백만원, 시가총액을 억원으로 주는데
-- 다른 표가 전부 원이므로 여기서 맞춰 넣습니다.

CREATE TABLE IF NOT EXISTS kr_daily_universe (
  session_date date NOT NULL,
  symbol text NOT NULL,
  name text NOT NULL,
  market text NOT NULL,
  close_price numeric,
  change_rate numeric,
  volume numeric,
  turnover numeric,
  market_cap numeric,
  trade_halted boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_date, symbol)
);

-- 하루 전체를 크기순으로 — 순위 밖 급등주를 찾는 축입니다.
CREATE INDEX IF NOT EXISTS kr_daily_universe_session_idx
  ON kr_daily_universe (session_date DESC, change_rate DESC);

-- 한 종목의 일봉 — 짝꿍이 며칠에 걸쳐 따라갔는지 보는 축입니다.
CREATE INDEX IF NOT EXISTS kr_daily_universe_symbol_idx
  ON kr_daily_universe (symbol, session_date DESC);

-- 오늘 멈춰 있는 것들. 부분 인덱스라 정지 종목이 138개일 때 138행만 읽습니다.
CREATE INDEX IF NOT EXISTS kr_daily_universe_halted_idx
  ON kr_daily_universe (session_date DESC, market_cap DESC)
  WHERE trade_halted;
