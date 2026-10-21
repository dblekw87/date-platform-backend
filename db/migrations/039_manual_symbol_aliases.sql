-- 손으로 넣는 별칭. 034에서 자리만 잡아 둔 source='manual'의 첫 줄입니다.
--
-- 2026-10-20 17:15 「美 중국 태양광 우회 수출에 철퇴…한화·OCI 반사이익」은
-- 상호가 'OCI'인 화학회사(456040)에만 붙었습니다. 다음날 오른 것은 미국 태양광
-- 자회사를 가진 OCI홀딩스(010060, 시가 +5.7%·종가 무렵 +9.95%)였고 OCI는 +1.3%.
-- 사용자 말로도 "태양광이면 보통 OCI홀딩스가 오른다".
--
-- 별칭을 'OCI'로 두면 두 종목에 함께 걸립니다(news.mjs가 같은 이름을 함께
-- 태깅합니다). 어느 쪽인지 기사만으로 가르지 않습니다 -- 둘 다 보여 주고
-- 시세가 가르게 둡니다. backfill-kr-aliases.mjs는 source='dart-eng'만 지우므로
-- 이 줄은 자동 갱신에 지워지지 않습니다.

INSERT INTO kr_symbol_aliases (symbol, alias, source, corpus_hits)
VALUES ('010060', 'OCI', 'manual', NULL)
ON CONFLICT (symbol, alias) DO NOTHING;
