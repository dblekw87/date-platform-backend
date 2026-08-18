<#
  Brings the collector up for a trading day with nobody at the keyboard.

  The price series is the one thing here that cannot be backfilled: a minute not
  sampled at 09:07 is gone, while the US pipeline re-fetches a week on its own.
  So this script exists to make the 08:00-15:40 KST window survive the morning
  rather than depend on remembering to open two windows before the bell.

  Order matters and each step waits for the one before it:

    docker      the daemon, which the postgres container follows on its own
                because compose declares restart: unless-stopped
    postgres    port 5432 answering, since a server that starts without a
                database logs "collector disabled" and then does nothing all day
    server      node, detached, with its output on disk

  Written for Windows PowerShell 5.1 so Task Scheduler can run it with the shell
  that is always present.
#>

param(
  # Six minutes rather than four because the caller is the Startup folder, which
  # gets one attempt and no retry: this runs at logon, when Docker Desktop is
  # cold-starting against everything else the machine is loading. Waiting longer
  # costs a hidden process sleeping; giving up early costs the trading day.
  [int] $DockerWaitSeconds = 360,
  [int] $DatabaseWaitSeconds = 120,
  [int] $ServerWaitSeconds = 60
)

$ErrorActionPreference = "Stop"
# Native command failures are checked through $LASTEXITCODE below; on PowerShell
# 7.4+ this would otherwise turn a probing `docker ps` into a terminating error.
$PSNativeCommandUseErrorActionPreference = $false

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"
$stamp = Get-Date -Format "yyyy-MM-dd"
$runLog = Join-Path $logDir "start-$stamp.log"
$serverLog = Join-Path $logDir "server-$stamp.log"
$serverErrorLog = Join-Path $logDir "server-$stamp.err.log"
$backendPort = 4010
$databasePort = 5432

if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Write-Line {
  param([string] $Message)

  $line = "{0} {1}" -f (Get-Date -Format "HH:mm:ss"), $Message

  Add-Content -Path $runLog -Value $line
  Write-Output $line
}

function Test-Port {
  param([int] $Port)

  $client = New-Object System.Net.Sockets.TcpClient

  try {
    $client.Connect("127.0.0.1", $Port)

    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Wait-Port {
  param([int] $Port, [int] $Seconds, [string] $Label)

  $deadline = (Get-Date).AddSeconds($Seconds)

  while ((Get-Date) -lt $deadline) {
    if (Test-Port -Port $Port) { return $true }

    Start-Sleep -Seconds 3
  }

  Write-Line "$Label did not answer on :$Port within $Seconds s"

  return $false
}

function Test-DockerDaemon {
  docker ps 2>&1 | Out-Null

  return $LASTEXITCODE -eq 0
}

Write-Line "--- start-collector ---"

# A dev window already holding :4010 is the normal case when someone is working.
# Starting a second listener would only fail on EADDRINUSE and leave a confusing
# error in the log, so treat it as done.
if (Test-Port -Port $backendPort) {
  Write-Line "backend already listening on :$backendPort - nothing to do"
  exit 0
}

if (Test-DockerDaemon) {
  Write-Line "docker daemon already up"
} else {
  $dockerDesktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"

  if (-not (Test-Path $dockerDesktop)) {
    Write-Line "Docker Desktop not found at $dockerDesktop"
    exit 1
  }

  Write-Line "starting Docker Desktop"
  Start-Process -FilePath $dockerDesktop | Out-Null

  $deadline = (Get-Date).AddSeconds($DockerWaitSeconds)
  $ready = $false

  while ((Get-Date) -lt $deadline) {
    if (Test-DockerDaemon) { $ready = $true; break }

    Start-Sleep -Seconds 5
  }

  if (-not $ready) {
    Write-Line "docker daemon did not come up within $DockerWaitSeconds s"
    exit 1
  }

  Write-Line "docker daemon up"
}

if (-not (Wait-Port -Port $databasePort -Seconds $DatabaseWaitSeconds -Label "postgres")) {
  exit 1
}

Write-Line "postgres up on :$databasePort"

$node = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $node) {
  $node = Join-Path $env:ProgramFiles "nodejs\node.exe"
}

if (-not (Test-Path $node)) {
  Write-Line "node not found"
  exit 1
}

# Start-Process truncates its redirect targets, so a second start on the same
# day silently erases the first one's output - which is how the morning of the
# first collection day was lost. Moved aside rather than appended to because the
# launch itself is the one thing here that must not get more clever: keeping the
# proven call is worth more than tidy filenames.
#
# Wrapped because a locked or unwritable log is a reason to lose history, never
# a reason not to start collecting.
foreach ($file in @($serverLog, $serverErrorLog)) {
  if (Test-Path $file) {
    try {
      $suffix = (Get-Date -Format "HHmmss")
      Move-Item -Path $file -Destination ($file -replace "\.log$", ".$suffix.log") -Force
    } catch {
      Write-Line "could not rotate $file - it will be overwritten"
    }
  }
}

# WorkingDirectory is load-bearing, not tidiness: config.mjs reads the .env
# through existsSync(".env"), so a server started anywhere else comes up with no
# DATABASE_URL and disables the collector it was started for.
Write-Line "starting backend from $root"
Start-Process -FilePath $node `
  -ArgumentList "src/server.mjs" `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $serverLog `
  -RedirectStandardError $serverErrorLog | Out-Null

if (Wait-Port -Port $backendPort -Seconds $ServerWaitSeconds -Label "backend") {
  # ASCII only in log lines: Task Scheduler runs this under Windows PowerShell
  # 5.1, which reads a BOM-less UTF-8 script as ANSI and mangles anything else.
  Write-Line "backend listening on :$backendPort - log $serverLog"
  exit 0
}

# Saying only "it did not start" would mean opening two files to find out why,
# on a morning where the window to fix it is minutes long.
Write-Line "backend failed to start - last lines of its output:"

foreach ($file in @($serverLog, $serverErrorLog)) {
  if (Test-Path $file) {
    Get-Content -Path $file -Tail 10 | ForEach-Object { Write-Line "  $_" }
  }
}

exit 1
