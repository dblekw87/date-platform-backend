<#
  A daily dump of the database, because the collected series cannot be refetched.

  Most of what is in there could be rebuilt: us_daily_bars and us_filings are
  large but they are downloads, and given a few days of five-requests-a-minute
  they come back. The 48MB that cannot is the point of this - the minute series
  the collector writes exists nowhere else, and a headline corpus is gone the
  moment the feeds roll it off. A lost docker volume would take the whole reason
  the machine has been left running.

  Written whole rather than incrementally. The database is 1.8GB and the disk
  has 426 free, so cleverness here would buy nothing and cost the one property
  that matters, which is that a restore is one command.

  Guarded on the date so the hourly caller makes one a day, and the dump is
  checked for size before the old ones are pruned - a truncated file that
  replaced fourteen good ones would be worse than no backup at all.
#>

param(
  [string] $Container = "date-platform-postgres",
  [string] $Database = "date_platform",
  [string] $User = "date_user",
  [string] $Destination = "C:\Users\Pangwoo\date-platform-backups",
  [int] $KeepDays = 14,
  [int] $MinimumBytes = 20MB
)

$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false

$stamp = Get-Date -Format "yyyy-MM-dd"
$log = Join-Path $Destination "backup.log"
$target = Join-Path $Destination "date_platform-$stamp.dump"

function Write-Line {
  param([string] $Message)

  if (Test-Path $Destination) {
    Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format "MM-dd HH:mm:ss"), $Message)
  }

  Write-Output $Message
}

if (-not (Test-Path $Destination)) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
}

if (Test-Path $target) {
  Write-Line "already backed up today"
  exit 0
}

docker ps 2>&1 | Out-Null

if ($LASTEXITCODE -ne 0) {
  Write-Line "docker not running, skipping"
  exit 0
}

Write-Line "dumping $Database"

# Dumped inside the container and copied out rather than piped through the
# shell. -Fc is a binary format and PowerShell's pipeline re-encodes text, which
# corrupts it silently - the file arrives, it simply cannot be restored.
docker exec $Container pg_dump -U $User -d $Database -Fc -f /tmp/backup.dump 2>&1 | ForEach-Object { Write-Line "  $_" }

if ($LASTEXITCODE -ne 0) {
  Write-Line "pg_dump failed, keeping previous backups"
  exit 1
}

docker cp "${Container}:/tmp/backup.dump" $target 2>&1 | ForEach-Object { Write-Line "  $_" }
docker exec $Container rm -f /tmp/backup.dump 2>&1 | Out-Null

if (-not (Test-Path $target)) {
  Write-Line "copy failed, keeping previous backups"
  exit 1
}

$size = (Get-Item $target).Length

if ($size -lt $MinimumBytes) {
  Write-Line ("dump is only {0:N0} bytes - too small to trust, removing and keeping previous backups" -f $size)
  Remove-Item $target -Force
  exit 1
}

Write-Line ("wrote {0} ({1:N0} MB)" -f (Split-Path $target -Leaf), ($size / 1MB))

# Pruned only after a good dump landed, so a run of failures cannot age out the
# last working copy.
$cutoff = (Get-Date).AddDays(-$KeepDays)
$stale = Get-ChildItem $Destination -Filter "date_platform-*.dump" | Where-Object { $_.LastWriteTime -lt $cutoff }

foreach ($file in $stale) {
  Write-Line "pruning $($file.Name)"
  Remove-Item $file.FullName -Force
}

$kept = @(Get-ChildItem $Destination -Filter "date_platform-*.dump")

Write-Line ("{0} backup(s) held" -f $kept.Count)
exit 0
