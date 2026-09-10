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
# Null until Measure-NewsGap has run. See the function for why the answer
# has to be taken before the backend starts rather than asked for later.
$script:newsGapDays = $null

if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Write-Line {
  param([string] $Message)

  $line = "{0} {1}" -f (Get-Date -Format "HH:mm:ss"), $Message

  Add-Content -Path $runLog -Value $line
  Write-Output $line
}

<#
  한 번에 하나만 돕니다.

  이 스크립트는 두 곳에서 불립니다 - 시작프로그램 폴더의 start-collector.cmd와
  작업 스케줄러의 "DATE market collector". 로그온하면 둘이 거의 같은 순간에 뜨고,
  그때는 :4010도 도커도 아직 없으므로 **포트 가드가 둘 다 통과시킵니다.** 그
  결과가 2026-09-06에 실제로 났습니다: 23:16:31과 23:16:52 두 실행이 Docker
  Desktop을 각각 띄워 엔진이 500을 뱉는 상태로 엉켰고(Docker Desktop 프로세스 3개,
  com.docker.backend 2개), 백업은 컨테이너 안 /tmp/backup.dump를 서로 밀어내
  "could not open file"로 죽었습니다.

  포트 가드는 이미 뜬 백엔드를 두 번 띄우지 않게 하는 것이지, 두 실행이 겹치는
  것을 막지는 못합니다. 겹침은 여기서 막습니다.

  뮤텍스는 프로세스가 끝나면 OS가 놓아주므로 따로 반납하지 않습니다. 앞선 실행이
  비정상 종료해 남긴 것은 AbandonedMutexException으로 오는데, 그것은 잡은 것으로
  칩니다 - 주인이 없다는 뜻이니까요.
#>
$runLock = New-Object System.Threading.Mutex($false, "Global\DATE-start-collector")
$holdsLock = $false

try {
  $holdsLock = $runLock.WaitOne(20000)
} catch [System.Threading.AbandonedMutexException] {
  $holdsLock = $true
}

if (-not $holdsLock) {
  Write-Line "another start-collector is running - nothing to do"
  exit 0
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
  # try/catch rather than a bare probe: Windows PowerShell 5.1 raises a native
  # command's stderr as an ErrorRecord, and the $ErrorActionPreference = "Stop"
  # at the top of this script turns that into a terminating error. A daemon that
  # is down writes to stderr, so the probe killed the script on exactly the
  # cold-boot path it exists to detect - and silently, since nothing after
  # "--- start-collector ---" ever ran. Measured 2026-08-22: three scheduled
  # runs died there after a reboot, and the "starting Docker Desktop" branch
  # below had never once executed in four days of logs. Redirecting with 2>$null
  # is not enough; it still throws.
  try {
    docker ps 2>$null | Out-Null
  } catch {
    return $false
  }

  return $LASTEXITCODE -eq 0
}

<#
  The daily database dump.

  Hung off this script because the hourly scheduled task is the only recurring
  trigger available without elevation, and it has to run on both paths: the
  normal case by far is a backend already up, which returns below without
  reaching the end. backup-db.ps1 guards its own date, so eleven of the twelve
  calls a day do nothing but check a filename.
#>
function Invoke-DailyBackup {
  & (Join-Path $PSScriptRoot "backup-db.ps1") 2>&1 | ForEach-Object { Write-Line "  backup: $_" }
}

<#
  하루 한 번 도는 측정 실행.

  백업과 같은 자리에 매단 이유도 같습니다 -- 권한 없이 쓸 수 있는 되풀이 트리거가
  이 시간마다 도는 작업뿐이고, 두 경로(백엔드가 이미 떠 있는 흔한 경우와 방금 띄운
  경우) 모두에서 불려야 합니다. run-analysis.ps1이 날짜와 시각을 스스로 잠그므로
  하루 열두 번 불려도 실제로 도는 것은 장 끝난 뒤 한 번입니다.
#>
function Invoke-DailyAnalysis {
  & (Join-Path $PSScriptRoot "run-analysis.ps1") 2>&1 | ForEach-Object { Write-Line "  analysis: $_" }
}

<#
  Backfilling the news the machine missed while it was off.

  The price series cannot be recovered, but the news can: Google News RSS takes
  after: / before:, so an article published while the laptop was shut down is
  still there to be fetched. This is what makes it safe to turn the machine off
  over a weekend.

  Called on both paths for the same reason as the backup above. It costs nothing
  when nothing is missing - backfill-news.mjs measures the gap itself and exits
  in a second if the newest article is under six hours old.

  Push-Location is load-bearing, the same way -WorkingDirectory is for the
  server below: config.mjs reads the .env through existsSync(".env"), so this
  resolves against whatever directory the caller happened to be in. Started
  from anywhere but the repo root it died with "DATABASE_URL is not configured"
  and the weekend backfill silently never ran. run-analysis.ps1 already wraps
  its node calls this way.
#>
function Invoke-NewsBackfill {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source

  if (-not $node) { return }

  $arguments = @((Join-Path $PSScriptRoot "backfill-news.mjs"))

  # Measured before the backend came up, on the cold path. Without it the script
  # measures its own live collection and always finds nothing to do.
  if ($null -ne $script:newsGapDays) {
    $arguments += @("--days", "$script:newsGapDays")
  }

  Push-Location $root
  try {
    & $node $arguments 2>&1 | ForEach-Object { Write-Line "  news: $_" }
  } finally {
    Pop-Location
  }
}

<#
  How big the news hole is, asked before anything can fill it.

  backfill-news.mjs sizes the hole as the age of the newest Korean article, and
  that reading is only true while the collector is still down. The cold path
  starts the backend, whose first news tick lands within seconds, and then spends
  55 seconds on the database dump before getting here - so every backfill on this
  path read a fresh article and exited. Measured on 2026-09-06: 35 hours off the
  air, and the log said the newest article was under six hours old. The weekend
  the machine was off is exactly the weekend this was written to recover.

  So the reading is taken here, between postgres answering and the server being
  launched, and carried to the call as --days.

  Push-Location for the reason given above Invoke-NewsBackfill: config.mjs reads
  the .env relative to the caller's directory.

  A failure is not worth stopping the morning for: leaving $newsGapDays null puts
  the backfill back on its own measurement, which is where it was before.
#>
function Measure-NewsGap {
  param([string] $NodePath)

  Push-Location $root
  try {
    $measured = & $NodePath (Join-Path $PSScriptRoot "backfill-news.mjs") "--measure" 2>&1
    $parsed = 0

    if ([int]::TryParse(($measured | Select-Object -Last 1), [ref] $parsed)) {
      $script:newsGapDays = $parsed
      Write-Line "news gap measured before start: $parsed day(s)"
    } else {
      Write-Line "could not measure the news gap - backfill will measure it itself"
    }
  } catch {
    Write-Line "could not measure the news gap - backfill will measure it itself"
  } finally {
    Pop-Location
  }
}

Write-Line "--- start-collector ---"

# Three things can call this within the same few seconds of a logon: the
# scheduled task, the watchdog, and anyone running it by hand. The port guard
# below only covers the instant it runs; between it and Start-Process sit the
# Docker wait, the postgres wait and the news-gap measurement, which is exactly
# where the watchdog's own start landed on 2026-09-09 (23:51:27 against this
# script's 23:51:29, and the loser died on EADDRINUSE). A named mutex makes the
# whole run single-instance, and Test-Port is asked once more right before the
# launch for whatever slipped past the mutex. An abandoned mutex - the previous
# holder died mid-run - counts as acquired, since there is nobody left to wait for.
$startLock = New-Object System.Threading.Mutex($false, "Global\DateCollectorStart")
$lockHeld = $false

try {
  $lockHeld = $startLock.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  $lockHeld = $true
}

if (-not $lockHeld) {
  Write-Line "another start-collector is already running - exiting"
  exit 0
}

# A dev window already holding :4010 is the normal case when someone is working.
# Starting a second listener would only fail on EADDRINUSE and leave a confusing
# error in the log, so treat it as done.
if (Test-Port -Port $backendPort) {
  Write-Line "backend already listening on :$backendPort - nothing to start"
  Invoke-DailyBackup
  Invoke-DailyAnalysis
  Invoke-NewsBackfill
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

Measure-NewsGap -NodePath $node

# Second look at the port: the waits above can span minutes, and a backend that
# came up meanwhile must not be joined by a second one.
if (Test-Port -Port $backendPort) {
  Write-Line "backend came up on :$backendPort while waiting - nothing to start"
  Invoke-DailyBackup
  Invoke-DailyAnalysis
  Invoke-NewsBackfill
  exit 0
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
  Invoke-DailyBackup
  Invoke-DailyAnalysis
  Invoke-NewsBackfill
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
