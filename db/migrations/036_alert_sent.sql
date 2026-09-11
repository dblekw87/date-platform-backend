-- 오늘 이미 나간 알림. 모든 알림 모듈이 같은 표를 씁니다.
--
-- 035에서 짝꿍 하나만 표로 옮겼는데, 같은 구조의 모듈이 일곱 개 더 있었습니다 --
-- 상한가·상한가 근접·주도 섹터·특징주·미국 급등·미국 개장 신호·종가배팅·섹터 2등주.
-- 전부 "그날 무엇을 보냈나"를 프로세스 메모리에 두고 있어서 장중 재기동 한 번에
-- 오전 알림이 다시 나갑니다. 모듈마다 표를 만들면 여덟 개가 되므로 하나로 합칩니다.
--
-- kind가 모듈, key가 그 모듈이 "같은 알림"으로 보는 단위입니다:
--   limit_pair       정렬된 두 종목 코드 'A|B'      rank = 보낸 최고 등급
--   limit_up         종목 코드                       (잠긴 뒤 한 통)
--   limit_up_near    종목 코드                       (잠기기 전 한 통)
--   leader_sector    'ranking'                       note = 마지막으로 보낸 섹터 순서
--   featured         기사 제목 키                    (특징주 기사 한 건)
--   us_surge         티커
--   us_open_signal   티커
--   close_bet        'sent'                          (하루 한 통)
--   sector_follower  'done'                          (하루 한 번, 기록까지 포함)
--
-- 행은 보낸 뒤에만 씁니다. 실패한 것을 보냈다고 적으면 영영 다시 안 보냅니다.
-- 날짜 단위라 자정에 비울 것이 없습니다 -- 어제 행은 오늘 조회에 걸리지 않습니다.
CREATE TABLE IF NOT EXISTS alert_sent (
  kind text NOT NULL,
  session_date date NOT NULL,
  key text NOT NULL,
  rank integer NOT NULL DEFAULT 0,
  note text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, session_date, key)
);

INSERT INTO alert_sent (kind, session_date, key, rank, note, sent_at)
SELECT 'limit_pair', session_date, pair_key, rank, tier, sent_at
  FROM kr_pair_alert_sent
ON CONFLICT DO NOTHING;

DROP TABLE kr_pair_alert_sent;
