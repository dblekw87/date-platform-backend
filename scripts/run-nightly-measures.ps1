<#
  장이 완전히 끝난 뒤 다시 재는 것들.

  사용자 요청(2026-09-27): "매일 표본 쌓이면 돌려주면 될 것 같아, 국내장 8시 끝나고
  나서" + "그걸 또 일주일 단위로" + "한 달 뒤에도". 국내장은 KRX 애프터마켓까지
  20:00에 끝나므로 그 뒤입니다.

  **왜 세션 크론이 아니라 이 스크립트인가.** 클로드 쪽 크론은 세션 안에만 살아서
  7일 뒤 만료되고, 토요일 종료·일요일 기동으로 세션이 새로 뜨면 사라집니다. 한 달
  뒤에 다시 재는 약속은 그렇게 지킬 수 없습니다. 측정 자체는 여기서 돌려 로그에
  쌓고, 클로드는 그 로그를 읽어 사람에게 말합니다 -- 잊는 쪽과 말하는 쪽을 나눕니다.

  세 깊이를 날짜로 고릅니다. 크론 세 개를 두는 것보다 놓치는 경우가 적습니다.

    매일    --watch 한 줄. 표본이 얼마나 쌓였고 미리 정한 기준을 넘었는지.
    금요일  표 전체. 주말에 사람이 읽을 것이라 금요일 저녁에 둡니다(토요일 아침에
            기계가 꺼지므로 토요일에 두면 안 돌아갑니다).
    매달 1~7일의 첫 평일  전체 다시. 1일에 고정하면 주말에 걸려 안 돕니다.

  로그는 logs\pair-flow-watch.log 한 파일에 계속 덧붙입니다. 날짜별로 나누면
  "사흘 연속 기준을 넘었는가"를 세려고 파일 셋을 열어야 합니다.
#>

param(
  [switch] $Force
)

$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false

# node가 내는 한글을 콘솔 코드페이지로 읽어 깨뜨리지 않도록. start-collector.ps1에
# 같은 줄이 있고 같은 이유입니다(2026-09-26).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"
$log = Join-Path $logDir "pair-flow-watch.log"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

function Write-Line {
  param([string] $Message)

  # PS 5.1의 Add-Content 기본은 ANSI입니다.
  Add-Content -Path $log -Value $Message -Encoding UTF8
  Write-Output $Message
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $node) {
  Write-Line "$(Get-Date -Format 'yyyy-MM-dd HH:mm') node가 PATH에 없습니다 - 건너뜁니다"

  exit 0
}

<#
  오늘이 이번 달의 첫 평일인가.

  1일이 토·일이면 1일에는 기계가 꺼져 있거나 사람이 안 봅니다. 1~7일 중 첫 평일을
  '이번 달의 그 날'로 삼고, 같은 달에 두 번 돌지 않게 로그를 봅니다.
#>
function Test-FirstWeekdayOfMonth {
  $today = Get-Date

  if ($today.Day -gt 7) { return $false }
  if ($today.DayOfWeek -eq "Saturday" -or $today.DayOfWeek -eq "Sunday") { return $false }

  for ($day = 1; $day -lt $today.Day; $day += 1) {
    $earlier = Get-Date -Year $today.Year -Month $today.Month -Day $day

    if ($earlier.DayOfWeek -ne "Saturday" -and $earlier.DayOfWeek -ne "Sunday") { return $false }
  }

  return $true
}

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
$depth = if ($Force -or (Test-FirstWeekdayOfMonth)) { "monthly" }
  elseif ((Get-Date).DayOfWeek -eq "Friday") { "weekly" }
  else { "daily" }

Push-Location $root

try {
  $script = Join-Path $PSScriptRoot "measure-pair-flow.mjs"

  if ($depth -eq "daily") {
    # 판정 줄이 이미 날짜로 시작하므로 시각만 덧붙입니다. 날짜를 두 번 적으면
    # 사흘 연속인지 셀 때 눈이 걸립니다.
    $line = & $node $script "--watch" 2>&1 | Select-Object -Last 1

    Write-Line "$(Get-Date -Format 'HH:mm') $line"
  } else {
    Write-Line "$stamp === $depth 전체 재측정 ==="
    & $node $script 2>&1 | ForEach-Object { Write-Line "  $_" }
    Write-Line "$stamp === $depth 끝 ==="
  }
} catch {
  Write-Line "$stamp 측정 실패: $($_.Exception.Message)"
} finally {
  Pop-Location
}

exit 0
