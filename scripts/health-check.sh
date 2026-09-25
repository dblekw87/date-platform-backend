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
#
# 다만 시계만 보면 안 됩니다. DART는 휴장일에 접수를 받지 않으니 연휴가 길면 시간은
# 계속 늘어나는데 아무 문제가 없습니다. 2026 추석(09-24~09-27)에 이 줄이 48시간째부터
# 30분마다 떴습니다 -- 조용해야 하는 확인이 소음이 됐습니다.
#
# 그래서 **마지막 접수 뒤로 장이 실제로 열린 날**을 셉니다. 국내 휴장일 표는 코드에
# 없지만 DB가 대신 압니다: 장이 열린 날은 kr_daily_bars에 일봉이 쌓이고
# market_price_samples에 장중 표본이 들어옵니다. 휴장일엔 둘 다 비어 있습니다.
# 일봉은 마감 뒤에 들어오므로 장중 표본을 같이 봐서 당일도 세어집니다 -- 연휴 다음
# 월요일 오전에 수집이 깨져도 그날 안에 잡히게 하려고요.
#
# 둘 다 맞을 때만 알립니다: 48시간 넘게 없고, 그 사이 장이 한 번 이상 열렸다.
dlag=$($PSQL "select coalesce(extract(epoch from now() - max(observed_at))/3600, 999)::int from market_disclosures;" 2>/dev/null)
if [ -n "$dlag" ] && [ "$dlag" -gt 48 ]; then
  # 판단을 못 하면(쿼리 실패·표 비었음) 예전처럼 알립니다. 조용히 넘기는 쪽이 더 위험합니다.
  opened=$($PSQL "
    select count(*) from (
      select session_date as day from kr_daily_bars
      union
      select (observed_at at time zone 'Asia/Seoul')::date from market_price_samples where market='KR'
    ) sessions
    where sessions.day > (select (max(observed_at) at time zone 'Asia/Seoul')::date from market_disclosures);" 2>/dev/null)
  [ -z "$opened" ] && opened=1
  [ "$opened" -ge 1 ] && echo "PROBLEM DART 공시를 ${dlag}시간째 못 받고 있습니다 (그 사이 개장일 ${opened}일)"
fi

err=$(ls -t "$LOGS"/server-????-??-??.err.log 2>/dev/null | head -1)
if [ -n "$err" ]; then
  # us로 시작하는 실패만 봅니다. 국내 kis 경고는 휴장 중 의미가 없습니다.
  recent=$(tail -200 "$err" | grep -icE "us (pipeline|surge|leaders|intraday).*fail")
  [ "$recent" -gt 5 ] && echo "PROBLEM $recent US pipeline failures in the last 200 log lines"
fi
exit 0
