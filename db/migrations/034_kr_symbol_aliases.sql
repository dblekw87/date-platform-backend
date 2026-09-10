-- 종목을 부르는 다른 이름. 지금은 영문 상호 하나뿐입니다.
--
-- 2026-09-10에 에스투더블유(488280)가 오픈AI '데이브레이크' 합류 소식으로
-- +11.9% 마감했는데 `[재료]` 알림이 한 통도 안 나갔습니다. 기사 여섯 건 중
-- 다섯 건이 제목을 **S2W**로 썼고 우리 태깅은 한글 상호만 봅니다. 재료가 있어도
-- 없는 것으로 처리된 셈이고, 그날 종가배팅 판단에서 그 종목은 아예 보이지
-- 않았습니다.
--
-- **왜 표로 두는가.** 별칭은 우리가 만든 값입니다 -- DART 영문 상호에서 법인
-- 접미사를 떼고, 흔한 낱말을 걸러 남긴 것. 코드 안에서 매번 만들면 무엇이
-- 걸리고 있는지 볼 수 없고, 잘못 걸린 하나를 지우려면 규칙을 고쳐야 합니다.
-- 표에 있으면 한 줄 지우면 됩니다.
--
-- `source`는 어디서 왔는지입니다. 지금은 'dart-eng' 하나지만, 나중에 손으로
-- 넣는 별칭('한국항공우주' → 'KAI')이 생기면 그것과 구별되어야 합니다 --
-- 자동 갱신이 손으로 넣은 것을 지우면 안 됩니다.

CREATE TABLE IF NOT EXISTS kr_symbol_aliases (
  symbol text NOT NULL,
  alias text NOT NULL,
  source text NOT NULL,
  -- 코퍼스에서 실제로 몇 건에 걸렸는지. 저장할 때 재고 남겨 둡니다 --
  -- 나중에 오태깅을 의심할 때 "이 별칭이 원래 흔한가"를 다시 재지 않아도 됩니다.
  corpus_hits integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, alias)
);

-- 태깅은 별칭 전체를 한 번에 읽습니다. 종목별 조회는 점검할 때만 씁니다.
CREATE INDEX IF NOT EXISTS kr_symbol_aliases_alias_idx ON kr_symbol_aliases (alias);
