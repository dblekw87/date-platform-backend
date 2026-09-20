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

Write-Line "starting Remote Control session '$SessionName' in $ProjectPath"

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
  $output = & $claude --bg --remote-control $SessionName --add-dir $ExtraPath 2>&1

  foreach ($line in $output) { Write-Line "  $line" }
} catch {
  Write-Line "start failed: $($_.Exception.Message)"
} finally {
  Pop-Location
  $ErrorActionPreference = $previous
}
