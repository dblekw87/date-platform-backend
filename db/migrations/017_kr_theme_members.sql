-- 네이버 금융 테마 — the theme dictionary this project has been doing from memory.
--
-- Themes are the answer to why a stock rose today, and the members of one share
-- no industry: 남북경협 on 2026-08-18 was a resort, a rail signalling maker,
-- apparel and cement, all limit-up on one remark about the North, and every one
-- of them classified 미분류 because nobody had written the group down.
--
-- It was then written down by hand, from recall, and that went badly twice in
-- one sitting - a code recalled as 푸른기술 turned out to be 푸른로보틱스, and
-- one recalled as 파나시아 was 자안바이오. Both were caught by checking against
-- the register, which is the point: recall is not a source.
--
-- finance.naver.com/sise/theme.naver publishes about 280 themes with their
-- members, free, in EUC-KR HTML. Its 남북경협 has 29 names against the 14 that
-- were assembled by hand, and the 16 it adds are ones nobody here would have
-- thought of - 남광토건 and 현대건설 for 개성공단 construction, 한국전력 for
-- cross-border transmission, 녹십자 for medical aid. It also omits two that were
-- added by hand, 부산산업 and 대아티아이, which are the same two a broker's
-- screen declined to tag.
--
-- Stored rather than fetched live: 280 detail pages is 280 requests, the
-- membership moves at the pace of a human editor, and the collector needs this
-- synchronously on every tick.
--
-- A symbol belongs to several themes here, which the board cannot show. The
-- choice is made on read rather than baked in, so the rule can change without
-- refetching.

CREATE TABLE IF NOT EXISTS kr_theme_members (
  theme_no integer NOT NULL,
  theme_name text NOT NULL,
  symbol text NOT NULL,
  name text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (theme_no, symbol)
);

-- Read by symbol, because the question is always "what is this stock" rather
-- than "what is in this theme".
CREATE INDEX IF NOT EXISTS kr_theme_members_symbol_idx
  ON kr_theme_members (symbol);
