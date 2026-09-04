-- 상장일. 신규 상장주를 조건으로 걸 수 있게 하는 유일한 값입니다.
--
-- 사용자는 신규 상장주를 그날 헷지주로 씁니다 -- 회사가 무엇을 하는지가 아니라
-- **신규라는 사실 자체**가 조건이라, 재료도 차트도 볼 필요가 없다고 했습니다.
-- 그런데 우리에게는 그 사실을 담을 자리가 없었습니다. 종가배팅·짝꿍 쿼리는
-- `theme_name !~ '신규상장'`으로 오히려 **걸러내고** 있습니다. 사업 내용이 아니라
-- 상장 시점으로 묶인 테마라 같이 움직일 이유가 없다고 본 것인데, 이 매매에서는
-- 그게 정확히 조건입니다. 목적이 반대입니다.
--
-- **출처가 둘입니다.**
--
--   universe  kr_daily_universe에 처음 등장한 날. 전 종목 일별 스냅샷이라 상장
--             당일에 들어옵니다. 종목코드가 확실하고 우리 안에서 끝납니다.
--   kind      KRX KIND 상장 일정(`providers/krx.mjs`). 상장일과 회사명은 주는데
--             **종목코드가 없어** 이름으로 맞춰야 합니다. 대신 미래 일정이 있어
--             오늘 상장할 종목을 장 전에 알 수 있습니다.
--
-- 둘을 한 표에 두고 어디서 왔는지 남깁니다. universe 쪽이 코드가 확실하므로
-- 그것이 들어오면 kind가 준 날짜를 덮지 않고 확인만 합니다.
--
-- **수집 시작 이전은 알 수 없습니다.** kr_daily_universe가 2026-08-21부터라
-- 그 전에 상장한 종목은 첫 등장일이 8/21로 잡힙니다. `before_collection`이
-- 그것을 표시합니다 -- 이 행의 날짜는 상장일이 아니라 "적어도 이 날 이전"입니다.

CREATE TABLE IF NOT EXISTS kr_listings (
  symbol text PRIMARY KEY,
  name text,
  listed_on date NOT NULL,
  market text,
  source text NOT NULL,
  -- 수집 시작일과 같은 날 처음 보였다면 상장일을 모른다는 뜻입니다.
  before_collection boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);

-- "상장 N일차"를 묻는 질의가 대부분이라 날짜로 훑습니다.
CREATE INDEX IF NOT EXISTS kr_listings_listed_on_idx ON kr_listings (listed_on);
