<#
  매일 한 번 도는 측정 실행 -- 판정이 아니라 기록입니다.

  두 트랙 다 "며칠에 걸쳐 반복되는가"를 묻고 있고, 둘 다 하루치로는 아무 말도 할 수
  없습니다. 그래서 매일 결과를 파일로 남겨 두었다가 2주가 쌓인 뒤에 판정합니다.
  2026-08-19에 시작한 짝꿍 반복 트랙이 예약이 안 걸려 있어 그날 한 번 돌고 멈춰
  있었던 것이 이 파일을 만든 이유입니다.

    run_persistence.py        틱 차분 상관으로 나온 쌍이 며칠에 걸쳐 반복되는가
    explore-news-groups.mjs   기사 키워드가 여러 날 반복되는 씨앗을 만드는가

  날짜로 잠급니다. 시간마다 부르는 start-collector가 하루 한 번만 실제로 돌립니다.

  장이 끝난 뒤에 돌아야 그날이 표본에 들어옵니다. 15:40 이전이면 아무것도 하지
  않고 물러납니다 -- 오전에 돌면 그날이 반쯤 담긴 채로 기록됩니다.
#>

param(
  [string] $Root = (Split-Path -Parent $PSScriptRoot),
  [switch] $Force
)

$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false

$stamp = Get-Date -Format "yyyy-MM-dd"
$outDir = Join-Path $Root "analysis\daily"
$log = Join-Path $outDir "run.log"
$marker = Join-Path $outDir "$stamp.done"
$python = Join-Path $Root "analysis\.venv\Scripts\python.exe"

if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

function Write-Line {
  param([string] $Message)
  Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format "MM-dd HH:mm:ss"), $Message)
}

if ((Test-Path $marker) -and -not $Force) { exit 0 }

# 주말에는 새 표본이 없습니다. 금요일 결과를 토·일에 두 번 더 쓰면 반복 횟수가
# 부풀어 "매일 나온 쌍"처럼 보입니다.
$day = (Get-Date).DayOfWeek

if ($day -eq "Saturday" -or $day -eq "Sunday") {
  Write-Line "weekend - nothing new to measure"
  Set-Content -Path $marker -Value "weekend"
  exit 0
}

$minutes = (Get-Date).Hour * 60 + (Get-Date).Minute

if ($minutes -lt (15 * 60 + 40) -and -not $Force) { exit 0 }

Write-Line "--- run-analysis $stamp ---"

if (Test-Path $python) {
  $out = Join-Path $outDir "persistence-$stamp.txt"
  & $python (Join-Path $Root "analysis\run_persistence.py") 2>&1 | Out-File -FilePath $out -Encoding utf8
  Write-Line "persistence -> $out"
} else {
  # venv가 없으면 만들라고 적어만 둡니다. 여기서 pip install을 돌리면 아침에
  # 수집기가 네트워크를 기다리며 서 있게 됩니다.
  Write-Line "python venv missing at $python - run: python -m venv analysis\.venv"
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source

if ($node) {
  $out = Join-Path $outDir "news-groups-$stamp.txt"
  Push-Location $Root
  & $node "scripts\explore-news-groups.mjs" 2>&1 | Out-File -FilePath $out -Encoding utf8
  Pop-Location
  Write-Line "news groups -> $out"
} else {
  Write-Line "node not found"
}

Set-Content -Path $marker -Value (Get-Date -Format "o")
Write-Line "done"
