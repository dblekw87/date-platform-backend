-- 장중 외국인 순매수 추정.
--
-- KIS HHPTJ04160200이 하루 다섯 구간의 누적 추정치를 줍니다. 확정치(kr_investor_flow)는
-- 장이 끝나야 나오므로, 장중에 외국인이 어느 쪽으로 움직이는지 볼 수 있는 유일한
-- 창입니다.
--
-- 기관은 일부러 저장하지 않습니다. 2026-08-21 삼성전자에서 추정 -11,000주 대 확정
-- +1,306,652주로 부호부터 틀렸습니다. 외국인은 추정 1,222,000 대 확정 1,567,350으로
-- 방향과 규모가 맞습니다. 틀린 값을 옆에 두면 언젠가 누가 씁니다.
--
-- 구간(bsop_hour_gb)이 몇 시에 나오는지는 KIS 문서에 없어서, 그 구간을 처음 본 시각을
-- 같이 적어 관측으로 알아냅니다. 며칠 쌓이면 발표 시각표가 나오고, 그때는 폴링을
-- 그 시각에만 걸 수 있습니다.

CREATE TABLE IF NOT EXISTS kr_foreign_estimate (
  symbol text NOT NULL,
  session_date date NOT NULL,
  bucket integer NOT NULL,
  foreign_qty numeric,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, session_date, bucket)
);

CREATE INDEX IF NOT EXISTS kr_foreign_estimate_session_idx
  ON kr_foreign_estimate(session_date DESC, symbol);
