<#
  미국장이 끝나는 토요일 아침에 이 기계를 끕니다.

  사용자는 주말마다 같은 일을 손으로 합니다 - 미국 애프터마켓이 09:00 KST에 끝나면
  끄고 일요일 밤에 켭니다. 잊고 켜 두면 전기만 쓰고, 일찍 끄면 미국 금요일장 뒷부분을
  잃습니다. 금요일 정규장은 05:00 KST에, 애프터마켓은 09:00 KST에 끝나므로 그 뒤입니다.

  **끄기 전에 다음에 이어 붙일 세션 id를 적어 둡니다.** 그러면 일요일 밤 로그온 때
  start-claude-rc.ps1이 새 대화를 여는 대신 그 대화를 이어서 띄웁니다. 그게 없으면
  월요일 아침에 지금까지 이야기한 것이 전부 없는 채로 시작합니다.

  예약은 여기서 잠들어 기다립니다. 작업 스케줄러 등록은 이 기계에서 권한 상승이
  필요해서(restart-collector-at.ps1에 같은 이유가 적혀 있습니다) 분리 프로세스가
  자는 쪽이 간단합니다.

  **로그온마다 자동으로 뜹니다** (HKCU Run의 "DATE weekend shutdown", 2026-09-27).
  자는 프로세스는 재부팅이 지우고, 죽어도 아무 흔적을 안 남깁니다 -- 2026-09-26에
  09-23에 걸어 둔 예약이 사라져 있었고, 사용자가 "오늘 자동으로 꺼지지?" 하고 물어서야
  알았습니다. 안 물었으면 그 주말에 그냥 켜진 채로 있었을 겁니다. 사람이 손으로 거는
  예약은 거는 것을 잊거나 죽은 것을 모르므로, 켜질 때마다 스스로 다시 걸립니다.
  ("내가 감시 다시 걸어줘 안해도 되게" -- 사용자, 2026-09-23)

  손으로:
    powershell -ExecutionPolicy Bypass -File scripts\shutdown-after-us-close.ps1
    powershell ... -File scripts\shutdown-after-us-close.ps1 -At 09:05 -WhatIf
  취소:
    shutdown /a          (마지막 2분 예고 중일 때)
    작업 관리자에서 이 powershell 프로세스 종료  (그 전)
#>

param(
  [string] $At = "09:05",
  [string] $Day = "Saturday",
  # 비워 두면 logs\claude-rc-session.txt에 이미 적힌 값을 그대로 씁니다.
  [string] $SessionId = "",
  # 진짜 끄지 않고 로그만 남깁니다. 시각 계산을 확인할 때 씁니다.
  [switch] $WhatIf
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$log = Join-Path $logDir ("shutdown-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

function Write-Line {
  param([string] $Message)

  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message

  # PS 5.1의 Add-Content는 기본이 ANSI라 한글이 깨집니다. 다른 로그들이 여태
  # 깨진 채로 남아 온 것도 같은 이유입니다.
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Output $line
}

# 다음 <Day> <At>. 오늘이 그 요일이고 아직 시각 전이면 오늘입니다.
$parts = $At.Split(":")
$target = (Get-Date).Date.AddHours([int] $parts[0]).AddMinutes([int] $parts[1])

while ($target.DayOfWeek -ne $Day -or $target -le (Get-Date)) {
  $target = $target.AddDays(1)
}

<#
  이 예약은 하나만 자고 있어야 합니다.

  로그온마다 이것이 뜨게 해 뒀으므로(HKCU Run의 "DATE weekend shutdown") 로그오프·
  재로그온이 겹치면 둘이 같은 토요일을 기다리게 됩니다. 둘이 깨면 stop-collector가
  두 번 돌고 종료 예고도 두 번 나갑니다.

  start-collector.ps1과 같은 방식입니다 -- 이름 있는 뮤텍스를 잡고, 못 잡으면
  이미 자고 있는 것이 있다는 뜻이니 조용히 빠집니다. 주인 없이 남은 뮤텍스
  (앞선 프로세스가 강제 종료된 경우)는 잡은 것으로 칩니다.

  기다리는 동안 계속 들고 있어야 하므로 반납하지 않습니다. 프로세스가 끝나면
  OS가 놓아줍니다.
#>
$runLock = New-Object System.Threading.Mutex($false, "Global\DATE-weekend-shutdown")
$holdsLock = $false

try {
  $holdsLock = $runLock.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  $holdsLock = $true
}

if (-not $holdsLock) {
  Write-Line "이미 예약이 자고 있습니다 - 그냥 빠집니다"

  exit 0
}

Write-Line "--- shutdown-after-us-close --- 대상 $($target.ToString('yyyy-MM-dd HH:mm')) ($Day $At)"

<#
  이어 붙일 세션 id를 파일에 적어 둡니다.

  **고르지 않습니다.** 처음엔 `claude agents`에서 백그라운드 세션을 찾아 쓰게 했는데,
  2026-09-23에 그 목록이 **자기 자신을 빼고** 돌려준다는 걸 알았습니다 - 세션 안에서
  부르면 옆에 떠 있던 예전 대화만 보이고, 정작 이어 붙이고 싶은 대화가 안 보입니다.
  그래서 엉뚱한 id를 적었습니다.

  지금은 -SessionId로 받거나 이미 적힌 값을 그대로 씁니다. 사람이 한 번 정하면
  그 값이 유지되고, 일요일 밤 로그온 때 start-claude-rc.ps1이 그 대화를 이어 띄웁니다.
  바꾸려면 logs\claude-rc-session.txt를 고치거나 -SessionId로 부르면 됩니다.

  끌 때 파일 시각을 새로 해 두는 것도 이 함수가 합니다 - start-claude-rc.ps1이
  일주일 넘게 묵은 파일은 무시하기 때문입니다.
#>
function Save-SessionId {
  $file = Join-Path $root "logs\claude-rc-session.txt"
  $id = $SessionId

  if (-not $id -and (Test-Path $file)) {
    $id = (Get-Content -Path $file -Raw).Trim()
  }

  if (-not $id) {
    Write-Line "이어 붙일 세션 id가 없습니다 - 다음 로그온은 새 대화로 시작합니다"

    return
  }

  # 여러 줄이 들어가 있으면 첫 줄만 씁니다. 두 줄이면 --resume이 읽지 못합니다.
  $id = ($id -split "`r?`n")[0].Trim()

  if ($id -notmatch "^[0-9a-fA-F-]{16,}$") {
    Write-Line "세션 id 모양이 아닙니다: '$id' - 그대로 둡니다"

    return
  }

  Set-Content -Path $file -Value $id -Encoding ASCII
  Write-Line "이어 붙일 세션 $id"
}

Save-SessionId

while ((Get-Date) -lt $target) {
  $remaining = $target - (Get-Date)

  if ($remaining.TotalMinutes -gt 30) { Start-Sleep -Seconds 600 } else { Start-Sleep -Seconds 30 }
}

Write-Line "미국장 끝. 정리하고 끕니다."

Save-SessionId

# 수집기를 먼저 멈춥니다. 도커는 그대로 둡니다 - 윈도 종료가 컨테이너를 정리합니다.
$previous = $ErrorActionPreference
$ErrorActionPreference = "Continue"

try {
  & (Join-Path $PSScriptRoot "stop-collector.ps1") 2>&1 | ForEach-Object { Write-Line "  $_" }
} catch {
  Write-Line "수집기 정지 실패(무시하고 계속): $($_.Exception.Message)"
} finally {
  $ErrorActionPreference = $previous
}

if ($WhatIf) {
  Write-Line "WhatIf - 실제로 끄지 않았습니다"
  exit 0
}

# 2분 예고. 그 사이에 `shutdown /a`로 취소할 수 있습니다.
Write-Line "2분 뒤 종료합니다 (취소: shutdown /a)"
shutdown /s /t 120 /c "US session closed - scheduled by DATE collector. Cancel with: shutdown /a"
