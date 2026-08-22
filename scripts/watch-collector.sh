#!/usr/bin/env bash
#
# 수집이 멈추면 알립니다. 열려 있어야 할 시간에만.
#
#   bash scripts/watch-collector.sh
#
# 요일 확인이 이 스크립트의 핵심입니다. 2026-08-22(토) 09:06에 감시기 두 개가 나란히
# "KR 수집 중단, 마지막 표본 999분 전"으로 울렸는데, 금요일 장이 정상 종료된 상태였을
# 뿐입니다. 시각만 보고 요일을 안 봤기 때문입니다.
#
# 늑대소년이 된 경보는 없는 것보다 나쁩니다. 주말 내내 울린 뒤에는 진짜 중단이 나도
# 그냥 넘기게 됩니다.

cd "$(dirname "$0")/.." || exit 1

kr_alerted=0
us_alerted=0

pulse_field() {
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s)[process.argv[1]]??999)}catch{console.log(999)}})" "$1"
}

while true; do
  now=$((10#$(date +%H%M)))
  weekday=$(date +%u)

  # 토·일은 어느 시장도 열리지 않습니다. 미국 금요일 애프터마켓이 토요일 09:00 KST에
  # 끝나므로 그때까지만 미국을 봅니다.
  if [ "$weekday" -ge 6 ] && ! { [ "$weekday" -eq 6 ] && [ "$now" -le 850 ]; }; then
    sleep 600
    continue
  fi

  pulse=$(node scripts/check-morning.mjs pulse 2>/dev/null)

  if [ -z "$pulse" ]; then
    echo "WATCHDOG 조회 실패 $(date +%H:%M) — 백엔드나 DB가 응답하지 않습니다"
    sleep 600
    continue
  fi

  kr=$(printf '%s' "$pulse" | pulse_field krMinutes)
  us=$(printf '%s' "$pulse" | pulse_field usMinutes)

  # 국내 정규장 09:00-15:30, NXT 애프터 15:41-20:00. 월요일 아침은 프리마켓부터.
  if { [ "$now" -ge 900 ] && [ "$now" -le 1530 ]; } || { [ "$now" -ge 1545 ] && [ "$now" -le 1955 ]; }; then
    if [ "$kr" -gt 15 ] 2>/dev/null; then
      [ "$kr_alerted" = "0" ] && echo "KR 수집 중단  마지막 표본 ${kr}분 전 · $(date +%H:%M)" && kr_alerted=1
    else
      kr_alerted=0
    fi
  fi

  # 미국은 17:10부터 다음날 08:50까지. 월요일 새벽은 일요일 밤이 아니라 월요일 장입니다.
  if { [ "$now" -ge 1710 ] && [ "$weekday" -le 5 ]; } || { [ "$now" -le 850 ] && [ "$weekday" -ne 1 ]; }; then
    if [ "$us" -gt 25 ] 2>/dev/null; then
      [ "$us_alerted" = "0" ] && echo "US 수집 중단  마지막 표본 ${us}분 전 · $(date +%H:%M)" && us_alerted=1
    else
      us_alerted=0
    fi
  fi

  sleep 600
done
