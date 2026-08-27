-- 8-K 항목 코드.
--
-- form_type만으로는 "8-K가 있었다"까지만 알 수 있고, 실적 발표(2.02)와 임원
-- 변경(5.02)이 같은 값으로 뭉갭니다. 2026-08-26 측정에서 8-K가 전 회전율 구간에서
-- 1.0x로 나온 것이 그 때문일 수 있습니다 -- 424B4는 같은 조건에서 20배였습니다.
--
-- 별도 표가 아니라 컬럼입니다. 8-K가 아닌 서식에는 항목이 없고, 있는 것도 한 줄에
-- 쉼표로 들어오는 짧은 문자열이라 조인할 값이 아닙니다.
ALTER TABLE us_filings ADD COLUMN IF NOT EXISTS items text;

-- 채워진 것만 찾는 질의가 대부분입니다.
CREATE INDEX IF NOT EXISTS us_filings_items_idx
  ON us_filings (filed_date) WHERE items IS NOT NULL;

-- 어느 CIK까지 훑었는지. 5,470개를 한 번에 돌리면 중간에 끊겼을 때 처음부터
-- 다시 해야 하고, SEC는 초당 10건이라 그 대가가 큽니다.
CREATE TABLE IF NOT EXISTS us_filing_item_progress (
  cik integer PRIMARY KEY,
  checked_at timestamptz NOT NULL DEFAULT now(),
  filings_seen integer NOT NULL DEFAULT 0,
  items_filled integer NOT NULL DEFAULT 0
);
