-- 국내 공시를 실제로 저장합니다.
--
-- market_disclosures는 002에서 만들어진 뒤 한 번도 쓰이지 않았습니다. 보드는 DART를
-- 매번 새로 불러 그리기만 했고, 그래서 2026-08-21 삼성전자 주주환원 발표처럼 장중에
-- 값이 튄 사건을 나중에 돌아보면 공시가 남아 있지 않았습니다. SEC 쪽은 us_filings에
-- 269만 건이 쌓여 있는데 국내는 0건이었습니다.
--
-- 새 칼럼은 시각 때문에 필요합니다. OpenDART list.json은 접수 "날짜"만 주고 시각을
-- 주지 않아서 기존 코드가 09:00으로 박아 넣고 있었습니다. 그 값으로는 17:09 공정공시와
-- 17:19 자사주 결정을 가를 수 없고, 가르지 못하면 어느 쪽에 반응한 것인지 알 수
-- 없습니다. 시각은 DART 당일공시 목록에서 따로 받아오고, 받지 못한 건은 그렇다고
-- 적어 둡니다 -- 모르는 시각을 아는 척하는 것이 비어 있는 것보다 나쁩니다.

ALTER TABLE market_disclosures
  ADD COLUMN IF NOT EXISTS session_date date,
  ADD COLUMN IF NOT EXISTS filed_at_source text,
  ADD COLUMN IF NOT EXISTS report_name text,
  ADD COLUMN IF NOT EXISTS filer_name text,
  ADD COLUMN IF NOT EXISTS market_class text;

CREATE INDEX IF NOT EXISTS market_disclosures_session_idx
  ON market_disclosures(market, session_date DESC, filed_at DESC);

CREATE INDEX IF NOT EXISTS market_disclosures_symbol_idx
  ON market_disclosures(symbol, filed_at DESC)
  WHERE symbol IS NOT NULL AND symbol <> '';
