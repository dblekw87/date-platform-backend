<#
  Runs one npm script at a given moment, logging what it printed.

  A generalisation of the after-close sequence, for the case where the thing
  worth measuring only exists at a particular hour on a particular day - a probe
  that has to run while both books are open, for instance. The alternative is
  remembering, and the whole point of these scripts is that nobody is sitting at
  the keyboard.

  Polled in short sleeps rather than one long one, so a suspend in between lands
  on the target rather than overshooting by however long the lid was shut.

  Pass the moment without a space in it. Start-Process splits -ArgumentList on
  spaces before -File sees it, so "2026-08-19 10:30" arrives as two arguments,
  binding fails with PositionalParameterNotFound, and the process exits before
  writing anything - which from outside looks like the schedule silently not
  arming. The ISO form has no space.

    powershell -File scripts\run-at.ps1 -At 2026-08-19T10:30 -Script probe:nxt-coverage
#>

param(
  [Parameter(Mandatory = $true)] [string] $At,
  [Parameter(Mandatory = $true)] [string] $Script,
  [string] $Label
)

$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"
$name = if ($Label) { $Label } else { $Script -replace "[^a-zA-Z0-9]", "-" }
$log = Join-Path $logDir ("run-at-{0}.log" -f $name)

if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Write-Line {
  param([string] $Message)

  Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format "MM-dd HH:mm:ss"), $Message)
}

$target = [DateTime]::Parse($At)

Write-Line "=== armed: $Script at $At ==="

if ((Get-Date) -ge $target) {
  Write-Line "target already passed, running now"
} else {
  Write-Line ("waiting {0:N0} minutes" -f ($target - (Get-Date)).TotalMinutes)

  while ((Get-Date) -lt $target) {
    Start-Sleep -Seconds 30
  }
}

Write-Line "--- running ---"

Push-Location $root
try {
  & npm run $Script 2>&1 | ForEach-Object { Write-Line "  $_" }
} catch {
  Write-Line "  failed: $($_.Exception.Message)"
} finally {
  Pop-Location
}

Write-Line "=== done ==="
