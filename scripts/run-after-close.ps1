<#
  The evening sequence, for a laptop nobody is sitting at.

  Three things have to happen after the domestic session ends at 15:40, and all
  three are easy to forget:

    15:45  probe NXT's after-market. KIS answers the NX venue during the regular
           session - proven today, with turnover that differs from KRX - but
           nobody has ever asked it in the evening, and the answer decides
           whether four and a half hours a day are worth collecting
    16:05  probe again. One reading cannot tell a live book from a frozen one;
           two readings twenty minutes apart can
    16:10  restart the backend, so the day's code changes are live before
           tomorrow's pre-market

  Restarting last, on purpose: it is the step that must not be skipped, and
  putting it after the probes means a probe that hangs cannot cost the restart.
#>

param(
  [string] $ProbeAt = "15:45",
  [string] $SecondProbeAt = "16:05",
  [string] $RestartAt = "16:10"
)

$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"
$log = Join-Path $logDir ("after-close-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Write-Line {
  param([string] $Message)

  Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format "HH:mm:ss"), $Message)
}

function Wait-Until {
  param([string] $At)

  $target = [DateTime]::ParseExact((Get-Date -Format "yyyy-MM-dd") + " " + $At, "yyyy-MM-dd HH:mm", $null)

  if ((Get-Date) -ge $target) {
    Write-Line "$At already passed"

    return
  }

  Write-Line ("waiting {0:N0} minutes until {1}" -f ($target - (Get-Date)).TotalMinutes, $At)

  # Polled rather than one long sleep, so a suspend in between lands on the
  # target instead of overshooting by however long the lid was shut.
  while ((Get-Date) -lt $target) {
    Start-Sleep -Seconds 30
  }
}

function Invoke-Probe {
  param([string] $Label)

  Write-Line "--- probe $Label ---"

  Push-Location $root
  try {
    & npm run probe:nxt-after 2>&1 | ForEach-Object { Write-Line "  $_" }
  } catch {
    Write-Line "  probe failed: $($_.Exception.Message)"
  } finally {
    Pop-Location
  }
}

Write-Line "=== after-close sequence armed ==="

Wait-Until -At $ProbeAt
Invoke-Probe -Label $ProbeAt

Wait-Until -At $SecondProbeAt
Invoke-Probe -Label $SecondProbeAt

Wait-Until -At $RestartAt
Write-Line "--- restart ---"
& (Join-Path $PSScriptRoot "stop-collector.ps1") 2>&1 | ForEach-Object { Write-Line "  $_" }
Start-Sleep -Seconds 3
& (Join-Path $PSScriptRoot "start-collector.ps1") 2>&1 | ForEach-Object { Write-Line "  $_" }

Write-Line "=== done ==="
