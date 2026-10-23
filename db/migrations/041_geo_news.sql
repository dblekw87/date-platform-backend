-- 미국 대통령 발언과 지정학 뉴스.
--
-- 2026-10-24 사용자 요청입니다. 이란 전쟁, 러시아·우크라이나 전쟁, 알래스카 사업(LNG)
-- 같은 것이 국내 방산·정유·재건·강관 테마를 움직이는데, 우리 뉴스는 시장 매체와
-- 보도자료만 봐서 대통령 발언이 원문으로 들어오지 않았습니다.
--
-- 출처는 넷입니다. 트럼프 Truth Social은 공식 사이트가 Cloudflare 403이라 보관 사이트
-- trumpstruth.org RSS로 받습니다(제3자, 지연·중단 가능). 백악관 뉴스 RSS, 연방관보
-- 대통령 문서 API(행정명령·포고문, 서명 뒤 하루 이틀), 주제별 구글 뉴스 검색입니다.
--
-- topics는 우리가 붙인 주제 낱말이고 비어 있을 수 있습니다. 비어 있는 것도 남깁니다 --
-- 나중에 "발언이 장을 움직였나"를 재려면 안 보낸 것까지 있어야 합니다.

CREATE TABLE IF NOT EXISTS geo_news (
  key text PRIMARY KEY,
  source text NOT NULL,
  title text NOT NULL,
  url text,
  published_at timestamptz,
  topics text[] NOT NULL DEFAULT '{}',
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS geo_news_published_idx ON geo_news (published_at DESC);
