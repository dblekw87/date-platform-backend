-- 짝꿍매매 실측 성적표.
--
-- 짝꿍매매는 같은 테마에서 **상승률** 1등주가 상한가에 잠겼을 때 2등주를 사는
-- 매매입니다. 상한가는 더 높은 값에 거래가 안 되는 상태라, 그 종목을 사려던 수요가
-- 갈 곳을 잃고 같은 테마의 다음 종목으로 넘칩니다. 미국에서 이 매매가 성립하지
-- 않았던 이유도 같습니다 -- 가격제한폭이 없으면 수요가 그 종목 안에서 소화됩니다.
--
-- 99,108개 테마-일을 396개 장에 걸쳐 재서 나온 것들입니다. 전부 그날 시장 평균
-- 갭 대비 초과분이고, 2등주를 종가에 사서 익일 시가에 판 값입니다.
--
--   1등주 상한가(29%↑) & 2등주 15%↑   2,260건   +2.305%p   상회 57%
--   1등주 20~29%      & 2등주 15%↑     843건   -0.031%p   상회 45%
--
-- 상한가를 찍어야만 값이 있습니다. 20%대 후반까지 갔다가 못 잠긴 날은 0입니다.
-- 1등주 높이만 보면 이 경계가 안 보입니다 -- 5~10%에서 +0.086%p로 시작해
-- 25~29%에 +0.429%p까지 완만하다가 상한가에서 +0.972%p로 뜁니다.
--
-- 2등주도 달리고 있어야 합니다. 상한가인 날에도 2등주가 5% 미만이면 -0.045%p이고,
-- 10% 이상이면 +1.753%p입니다. 뒤처진 종목이 따라오는 매매가 아닙니다.
--
-- 간격은 좁을수록 좋습니다. 둘 다 15% 이상일 때 간격 0~2%p가 +3.778%p에 상회 64%로
-- 가장 좋고, 2~5%p는 -0.026%p입니다. 예전 짝꿍 패널은 간격이 넓은 순으로 정렬했는데
-- 정확히 거꾸로였습니다.
--
-- 그리고 하룻밤짜리입니다. 상한가 조합에서 갭이 +2.305%p인데 하루를 들고 있으면
-- +1.132%p로 절반이 됩니다.

CREATE TABLE IF NOT EXISTS kr_limit_pair_calibration (
  tier text PRIMARY KEY,
  min_leader_move numeric NOT NULL,
  min_second_move numeric NOT NULL,
  -- 1등주와 2등주의 간격 상한. 좁을수록 좋았으므로 등급을 가르는 축입니다.
  max_lead_gap numeric,
  samples integer NOT NULL,
  nights integer NOT NULL,
  beat_rate numeric NOT NULL,
  excess_mean numeric NOT NULL,
  gap_up_rate numeric NOT NULL,
  -- 하루 들고 있었을 때. 갭만 먹는 매매라는 것을 화면이 말할 수 있게 같이 둡니다.
  hold_excess_mean numeric NOT NULL,
  calibrated_from date NOT NULL,
  calibrated_to date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
