#!/bin/bash
#
# 수집기가 살아 있는지 한 번에 봅니다. **문제가 있을 때만 출력**하고, 조용하면 정상입니다.
#
#   bash scripts/health-check.sh
#
# 세션이 30분마다 이것을 돌려 보고, PROBLEM 줄이 나오면 폰으로 알립니다. 그래서
# 정상일 때 아무것도 안 내는 것이 중요합니다 -- 조용한 확인이 쌓여야 진짜 한 줄이 눈에 띕니다.
#
# 국내장이 닫힌 날(주말·공휴일)에도 그대로 씁니다. 국내 장중 표본이 안 들어오는 것은
# 그 날 정상이라 보지 않고, **어느 날이든 돌아야 하는 것**만 봅니다:
# 도커, 스냅샷 발행, 미국 정규장 표본, 미국 일봉 적재, 국내 뉴스·공시, 파이프라인 실패.
#
# 국내 뉴스·공시를 휴장에도 보는 이유: 연휴에 나온 공시가 다음 장 재료가 됩니다.
# 수집기는 시장 시간과 무관하게 뉴스를 받고, 공시는 주말만 건너뜁니다.
LOGS="C:/Users/Pangwoo/date-platform-backend/logs"
PSQL='docker exec date-platform-postgres psql -U date_user -d date_platform -Atc'
now=$(date +%s)
hhmm=$(date +%H%M)

if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^date-platform-postgres$'; then
  echo "PROBLEM postgres container not running"
fi

log=$(ls -t "$LOGS"/server-????-??-??.log 2>/dev/null | head -1)
if [ -z "$log" ]; then
  echo "PROBLEM no server log found"
else
  last=$(grep "snapshot published" "$log" | tail -1 | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}')
  if [ -n "$last" ]; then
    age=$(( (now - $(date -d "$last" +%s)) / 60 ))
    [ "$age" -gt 25 ] && echo "PROBLEM last snapshot ${age} min ago ($last)"
  else
    echo "PROBLEM no snapshot in the newest log"
  fi
fi

# 미국 정규장은 22:30~05:00 KST. 그 시간대에 표본이 안 들어오면 문제입니다.
# (미국 휴장일에는 빈 것이 정상이라 한 번쯤 헛경보가 날 수 있습니다 -- us-holidays.mjs를
#  여기서 읽지는 않습니다. 연달아 나오면 그때 보세요.)
if [ "$hhmm" \> "2245" ] || [ "$hhmm" \< "0450" ]; then
  fresh=$($PSQL "select count(*) from market_price_samples where market='US' and observed_at > now() - interval '15 minutes';" 2>/dev/null)
  [ -z "$fresh" ] && fresh=0
  [ "$fresh" -lt 50 ] && echo "PROBLEM US samples in the last 15 min: $fresh (정규장 시간인데 비었습니다)"
fi

# 파이프라인이 전날 미국장을 받아왔는가. 미국 거래일 기준으로 이틀 넘게 밀리면 문제.
lag=$($PSQL "select current_date - max(session_date) from us_daily_bars;" 2>/dev/null)
[ -n "$lag" ] && [ "$lag" -gt 3 ] && echo "PROBLEM us_daily_bars is ${lag} days behind"

# 국내 뉴스·공시는 휴장 중에도 들어옵니다. 연휴에 나오는 공시가 월요일 재료가 되므로
# 여기가 멈추면 국내장이 닫혀 있어도 손해입니다.
news=$($PSQL "select count(*) from market_news_items where region='KR' and observed_at > now() - interval '90 minutes';" 2>/dev/null)
[ -z "$news" ] && news=0
[ "$news" -lt 3 ] && echo "PROBLEM 국내 뉴스가 90분간 ${news}건 (수집이 멈췄을 수 있습니다)"

# 공시는 접수가 뜸한 시간대가 있어 건수로 못 봅니다. 마지막 접수가 이틀 넘게 없으면 봅니다.
dlag=$($PSQL "select coalesce(extract(epoch from now() - max(observed_at))/3600, 999)::int from market_disclosures;" 2>/dev/null)
[ -n "$dlag" ] && [ "$dlag" -gt 48 ] && echo "PROBLEM DART 공시를 ${dlag}시간째 못 받고 있습니다"

err=$(ls -t "$LOGS"/server-????-??-??.err.log 2>/dev/null | head -1)
if [ -n "$err" ]; then
  # us로 시작하는 실패만 봅니다. 국내 kis 경고는 휴장 중 의미가 없습니다.
  recent=$(tail -200 "$err" | grep -icE "us (pipeline|surge|leaders|intraday).*fail")
  [ "$recent" -gt 5 ] && echo "PROBLEM $recent US pipeline failures in the last 200 log lines"
fi
exit 0
