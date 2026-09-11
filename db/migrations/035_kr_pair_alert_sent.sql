-- 오늘 이미 보낸 짝꿍 알림.
--
-- 짝꿍 알림의 중복 방지는 프로세스 안의 Map이었습니다. 2026-09-11 11:15에 상한가
-- 알림 버그를 고치려고 백엔드를 재기동했더니 그 Map이 비면서, 오전에 이미 나간
-- 짝 여섯 통(케이씨에스→우리넷, 삼화콘덴서공업→솔루스첨단소재 등)이 같은 등급으로
-- 다시 발송됐습니다. 장중 재기동은 드물지 않고 -- 그날만 세 번이었습니다 --
-- 두 번 오는 알림은 읽지 않게 됩니다.
--
-- **kr_signal_outcomes에 넣지 않는 이유.** 그 표의 limit_pair 행은 밤 채점기
-- (nightly-review)가 그날의 짝을 사후에 재구성해 넣는 것이고, 2등주 한 종목이
-- 한 행입니다. 알림은 순서 없는 쌍(A|B)이 단위이고 등급이 오르면 같은 쌍을 다시
-- 보내므로 모양이 다릅니다. 억지로 섞으면 채점 집계에 "A|B" 종목이 끼어듭니다.
--
-- 행은 보낸 뒤에만 씁니다. 실패한 것을 보냈다고 적으면 영영 다시 안 보냅니다.
CREATE TABLE IF NOT EXISTS kr_pair_alert_sent (
  session_date date NOT NULL,
  -- 두 종목 코드를 정렬해 '|'로 이은 값. 1·2등이 자리를 바꿔도 같은 짝입니다.
  pair_key text NOT NULL,
  -- 지금까지 보낸 가장 높은 등급. 이보다 높은 등급이 올 때만 다시 보냅니다.
  rank integer NOT NULL,
  tier text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_date, pair_key)
);
