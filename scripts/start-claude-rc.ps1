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
      if ($session.cwd -ne $ProjectPath) { continue }
      if (Test-SessionDead -ClaudePath $ClaudePath -Id $session.id) { continue }

      return $true
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

<#
  목록에 있다고 살아 있는 것은 아닙니다 (2026-10-15).

  9/20에 띄운 1d0eb7b2가 `state: blocked`로 3주 넘게 목록에 남아 있었는데, 실제로는
  데몬이 없었습니다 - `claude logs`가 `connect ENOENT \\.\pipe\cc-daemon-*-control`로
  끝났습니다. 위 판정은 cwd만 보므로 이 항목 하나가 매 로그온마다 "이미 떠 있다"로
  자동 기동을 막았고, 폰이 붙을 세션이 없었습니다.

  status·state로 가르지 않습니다. 살아 있는 세션도 권한을 기다리면 blocked이고,
  죽은 항목은 status 칸이 비어 있었는데 그게 늘 그런지는 모릅니다. 대신 실제로
  붙어 보고, 로그를 못 읽으면 죽은 것으로 보고 내립니다. `claude stop`은 대화를
  지우지 않으므로 내리는 쪽이 안전합니다.

  Test-SessionRunning 안에서만 불리므로 EAP는 거기서 이미 Continue입니다.
#>
function Test-SessionDead {
  param([string] $ClaudePath, [string] $Id)

  if (-not $Id) { return $false }

  $probe = (& $ClaudePath logs $Id 2>&1 | Out-String)

  if ($probe -notmatch "Couldn't read logs") { return $false }

  Write-Line "죽은 세션 $Id 를 내립니다 - $($probe.Trim())"
  & $ClaudePath stop $Id 2>&1 | Out-Null

  return $true
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

  cron은 세션 메모리에만 있어 껐다 켜면 둘 다 사라집니다. 예전 프롬프트는 수집기
  감시 하나만 요청해서 미국장 야간 감시는 매번 손으로 다시 걸어야 했습니다.

  작은따옴표 here-string이어야 합니다. 큰따옴표 판에서는 백틱이 이스케이프라
  `bash가 백스페이스 + "ash"로 바뀌어 전달됐습니다(2026-10-25 로그에서 확인).
#>
$bootPrompt = @'
컴퓨터를 다시 켰습니다. 수집기 감시를 다시 걸어 주세요.

정상일 때는 대화에 아무것도 띄우지 않는 방식입니다(2026-10-26 사용자 요청: "문제 생겼을 때만"). cron으로 걸지 말고, Bash run_in_background 로 아래 한 줄을 띄우세요. 15분마다 health-check.sh 를 돌리다가 PROBLEM 이 나올 때만 끝나서 알려 줍니다. health-check.sh 는 국내·미국 장 시간과 휴장일을 스스로 가립니다.

  while true; do out=$(bash "C:/Users/Pangwoo/date-platform-backend/scripts/health-check.sh" 2>&1); if [ -n "$out" ]; then echo "$(date '+%m-%d %H:%M') $out"; exit 1; fi; sleep 900; done

먼저 CronList 에 health-check.sh 를 부르는 cron 이 있으면 지우세요(예전 방식). 이 루프가 끝나서 알림이 오면: 최신 서버 로그 끝을 짧게 확인하고, 한국어 한 줄(200자 이내) PushNotification 을 보내고, 대화에 요약한 뒤, 같은 루프를 다시 띄우세요. 스스로 재기동하지는 마세요.

그 다음 매일 학습 크론 두 개를 다시 거세요(2026-10-30 사용자와 시작한 테마 판단 학습). memory/session-resume-rearm.md 의 매일 학습 크론 절에 cron 식과 프롬프트 원문이 있습니다 - 그대로 CronCreate(recurring:true)로 겁니다. CronList 에 [매일 학습 으로 시작하는 것이 이미 있으면 겹치지 않게 건너뛰세요. 크론은 7일이면 만료되니 켤 때마다 다시 거는 것이 맞습니다.

이어 붙인 대화는 새 id의 복사본으로 뜹니다. 다음 주말에도 이 대화가 이어지도록, 지금 세션 id(이 대화를 적고 있는 ~/.claude/projects/C--Users-Pangwoo-date-platform/ 아래 가장 최근 jsonl 파일 이름)를 C:/Users/Pangwoo/date-platform-backend/logs/claude-rc-session.txt 에 줄바꿈 없이 덮어 적으세요.

띄운 뒤 지금 상태를 한 번 확인해서 한국어 두세 줄로 알려 주세요 - 수집기가 올라왔는지, 마지막 스냅샷이 언제인지, 국내 뉴스와 공시가 들어오고 있는지, 밀린 뉴스 백필이 몇 건 들어왔는지(logs/start-<오늘>.log).
'@

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
