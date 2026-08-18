<#
  Waits until a time today, then restarts the backend.

  The collector runs without --watch so that a code edit cannot bounce the
  server in the middle of a session, which means a fix does not reach the
  running process until someone restarts it. Doing that by hand at 15:45 is the
  kind of thing that gets forgotten, and the cost of forgetting is a whole
  trading day on the old code.

  Waits here rather than in a scheduled task because registering one needs
  elevation on this machine. A detached process sleeping until the close is
  enough for a one-shot.

  Default 15:45 is five minutes after the collector stops sampling at 15:40, so
  the restart cannot land inside the session.
#>

param(
  [string] $At = "15:45"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"
$log = Join-Path $logDir ("restart-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Write-Line {
  param([string] $Message)

  Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format "HH:mm:ss"), $Message)
}

$target = [DateTime]::ParseExact((Get-Date -Format "yyyy-MM-dd") + " " + $At, "yyyy-MM-dd HH:mm", $null)

Write-Line "--- restart-collector-at $At ---"

if ((Get-Date) -ge $target) {
  Write-Line "$At already passed, restarting now"
} else {
  Write-Line ("waiting {0:N0} minutes until {1}" -f ($target - (Get-Date)).TotalMinutes, $At)

  # Polled rather than one long sleep so that a suspend-and-resume in between
  # lands on the target instead of overshooting by however long the lid was shut.
  while ((Get-Date) -lt $target) {
    Start-Sleep -Seconds 30
  }
}

Write-Line "stopping backend"
& (Join-Path $PSScriptRoot "stop-collector.ps1") 2>&1 | ForEach-Object { Write-Line "  $_" }

Start-Sleep -Seconds 3

Write-Line "starting backend"
& (Join-Path $PSScriptRoot "start-collector.ps1") 2>&1 | ForEach-Object { Write-Line "  $_" }

Write-Line "done"
