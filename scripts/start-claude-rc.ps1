<#
  Keeps one Remote Control session alive for this project, so the phone can
  reach this machine.

  Nothing was ever starting one. The logon path had two entries - the
  "DATE watchdog" Run key and the "DATE market collector" scheduled task - and
  neither touches claude, so whether a session showed up in the phone app
  depended entirely on how the session at the keyboard happened to be started.
  On 2026-09-20 it was started without --remote-control and therefore never
  appeared.

  Remote Control is a start-time flag: a session already running cannot be
  given it. So the only way to have one waiting is to start it, which is what
  this does.

  Single-instance the same way start-collector.ps1 is, and for the same reason:
  this runs at logon alongside everything else, and a background session that
  is started twice does not collide loudly - it just leaves a second idle
  session behind, every logon, until `claude agents` is a wall of them.

  **이어 붙이기 (2026-09-23).** logs\claude-rc-session.txt에 세션 id가 적혀 있으면
  새 대화를 여는 대신 그 대화를 이어서 띄웁니다. 사용자는 주말마다 끄고 켜는데
  (shutdown-after-us-close.ps1이 끄면서 id를 적습니다), 그때마다 새 대화가 열리면
  월요일 아침에 지금까지 이야기한 것이 전부 없는 채로 시작합니다.

  이어 붙이기가 실패하면 새 대화로 떨어집니다 - 세션 파일이 지워졌거나 너무 오래된
  경우입니다. 대화가 없는 것보다 낫고, 로그에 어느 쪽이었는지 남습니다.

  **감시도 같이 되살립니다 (2026-09-23).** 30분마다 도는 수집기 감시는 세션 메모리에만
  있어서 껐다 켜면 사라집니다. 그래서 세션을 띄울 때 첫 프롬프트로 "감시를 다시 걸어라"를
  같이 보냅니다 - 사용자가 켤 때마다 같은 말을 해야 하는 것을 없애려는 것입니다.

  Written for Windows PowerShell 5.1, like the other logon scripts here.
#>

param(
  [string] $SessionName = "date-platform",
  [string] $ProjectPath = "C:\Users\Pangwoo\date-platform",
  # The two repos are siblings and most of the work is on the backend - the
  # collector, the measurements, the alerts. A session rooted only in the
  # frontend has to ask before it can touch any of that, and the whole point
  # of this session is that nobody is at the keyboard to answer.
  [string] $ExtraPath = "C:\Users\Pangwoo\date-platform-backend"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$runLog = Join-Path $logDir ("claude-rc-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

function Write-Line {
  param([string] $Message)

  $line = "{0} {1}" -f (Get-Date -Format "HH:mm:ss"), $Message

  Add-Content -Path $runLog -Value $line
  Write-Output $line
}

<#
  Is one already up.

  `claude agents --json` is the machine-readable listing; the plain form
  refuses when stdout is not a TTY, which it never is here. The name given to
  --remote-control does not come back in that listing (it showed as the short
  id), so a background session sitting in this project's directory is the best
  available match. That errs toward not starting a second one, which is the
  right direction: a missing session is one command away, a pile of them is
  cleanup.
#>
function Test-SessionRunning {
  param([string] $ClaudePath)

  # Lowered for the same reason as the start call below - a native command that
  # writes anything to stderr would otherwise throw here.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"

  try {
    $raw = & $ClaudePath agents --json 2>$null

    if (-not $raw) { return $false }

    $sessions = $raw | ConvertFrom-Json

    foreach ($session in $sessions) {
      if ($session.kind -ne "background") { continue }
      if ($session.status -eq "exited") { continue }
      if ($session.cwd -eq $ProjectPath) { return $true }
    }
  } catch {
    # A listing we cannot read is not evidence that nothing is running, but it
    # is also not a reason to skip the morning. Treat it as "none" and let the
    # start attempt be the thing that fails loudly in the log.
    Write-Line "could not read the session list - assuming none"
  } finally {
    $ErrorActionPreference = $previous
  }

  return $false
}

Write-Line "--- start-claude-rc ---"

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source

if (-not $claude) {
  Write-Line "claude is not on PATH - nothing started"
  exit 0
}

if (Test-SessionRunning -ClaudePath $claude) {
  Write-Line "a background session is already up in $ProjectPath - nothing to start"
  exit 0
}

<#
  이어 붙일 세션이 있는가. 있으면 id를, 없으면 $null을 돌려줍니다.
  일주일 넘게 묵은 것은 쓰지 않습니다 - 그 사이 저장소도 데이터도 달라져 있어
  이어 붙이는 것이 오히려 헷갈립니다.
#>
function Read-ResumeId {
  $file = Join-Path $root "logs\claude-rc-session.txt"

  if (-not (Test-Path $file)) { return $null }

  $age = (Get-Date) - (Get-Item $file).LastWriteTime

  if ($age.TotalDays -gt 7) {
    Write-Line "세션 파일이 $([int] $age.TotalDays)일 지나 새 대화로 시작합니다"

    return $null
  }

  $id = (Get-Content -Path $file -Raw).Trim()

  if ($id -match "^[0-9a-fA-F-]{16,}$") { return $id }

  Write-Line "세션 파일을 읽을 수 없어 새 대화로 시작합니다"

  return $null
}

$resumeId = Read-ResumeId

<#
  세션이 뜨자마자 할 일.

  감시를 다시 거는 것이 전부입니다. 경로를 스크립트로 박아 두는 이유는, 예전에
  감시 스크립트가 세션별 임시 폴더에 있어 세션이 바뀌면 같이 사라졌기 때문입니다.
  이제 저장소 안(scripts/health-check.sh)에 있어 껐다 켜도 그대로입니다.
#>
$bootPrompt = @"
컴퓨터를 다시 켰습니다. 수집기 감시를 다시 걸어 주세요.

- 30분마다 `bash "C:/Users/Pangwoo/date-platform-backend/scripts/health-check.sh"` 를 돌립니다.
- 아무것도 안 나오면 정상이니 한 줄로만 답하고 알림은 보내지 마세요.
- PROBLEM 줄이 나오면 해당 로그 끝을 짧게 확인한 뒤 한국어 한 줄로 PushNotification을 보내고 대화에도 요약하세요.
- 스스로 재기동하지는 마세요.

거는 즉시 지금 상태를 한 번 확인해서 한국어 두세 줄로 알려 주세요 - 수집기가 올라왔는지, 마지막 스냅샷이 언제인지, 국내 뉴스와 공시가 들어오고 있는지.
"@

Write-Line $(if ($resumeId) { "이어서 시작합니다 · 세션 $resumeId" } else { "새 Remote Control 세션 '$SessionName' · $ProjectPath" })

<#
  ErrorActionPreference has to come down for the call itself.

  PowerShell 5.1 raises a native command's stderr as an ErrorRecord, and the
  "Stop" at the top of this script turns that into a terminating exception.
  claude announces itself on stderr ("Starting background service…"), so the
  first line it printed killed the pipeline before the background session was
  registered - the catch below logged "start failed" and nothing was running.
  This is the same trap that kept the collector's cold-boot recovery from ever
  working (docker ps on stderr, same Stop, same silent death); 2>$null alone
  does not avoid it, only lowering the preference does.
#>
$previous = $ErrorActionPreference
$ErrorActionPreference = "Continue"

try {
  Push-Location $ProjectPath

  # --bg returns as soon as the session is registered, so this does not hold the
  # logon open. Verified on 2026-09-20 that --bg still enables Remote Control:
  # the session appeared in the phone app even though the listing showed its id
  # rather than the name passed here.
  <#
    **프롬프트가 맨 앞이어야 합니다.** 2026-09-23 실측:

      claude --add-dir <경로> --bg ... "<프롬프트>"
        → "backgrounded · d71662d7 (idle - send a prompt to start)"  프롬프트가 안 먹음
      claude "<프롬프트>" --bg --add-dir <경로>
        → "backgrounded · db02f036"                                  먹음(state=done 확인)

    `claude [options] [command] [prompt]`이라 뒤에 두면 될 것 같지만 그렇지 않았습니다.
    뒤쪽 자리 인자는 여러 개를 받는 --add-dir에 먹히는 것으로 보입니다.
  #>
  $arguments = @($bootPrompt, "--bg", "--remote-control", $SessionName, "--add-dir", $ExtraPath)

  # --resume <id>는 --bg와 같이 쓰면 그 대화를 백그라운드로 이어 줍니다(claude --help).
  if ($resumeId) { $arguments += @("--resume", $resumeId) }

  $output = & $claude @arguments 2>&1

  foreach ($line in $output) { Write-Line "  $line" }

  <#
    이어 붙이기가 실패했으면 새 대화로 한 번 더 시도합니다. 실패는 stderr 한 줄로
    오고 종료 코드가 늘 정직하지는 않아, 세션 목록으로 확인하는 쪽이 확실합니다.
  #>
  if ($resumeId -and -not (Test-SessionRunning -ClaudePath $claude)) {
    Write-Line "이어 붙이기가 안 됐습니다 - 새 대화로 다시 시작합니다"
    # 새 대화로 떨어져도 감시는 걸려야 합니다. 프롬프트는 여기서도 맨 앞입니다.
    $output = & $claude $bootPrompt --bg --remote-control $SessionName --add-dir $ExtraPath 2>&1

    foreach ($line in $output) { Write-Line "  $line" }
  }
} catch {
  Write-Line "start failed: $($_.Exception.Message)"
} finally {
  Pop-Location
  $ErrorActionPreference = $previous
}
