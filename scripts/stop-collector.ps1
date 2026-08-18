<#
  Stops the backend that start-collector.ps1 left running.

  Only the node process holding :4010 is touched. Docker stays up: the postgres
  container costs nothing idle, and stopping it would also stop whatever else is
  using it.
#>

$ErrorActionPreference = "Stop"

$backendPort = 4010
$listeners = Get-NetTCPConnection -LocalPort $backendPort -State Listen -ErrorAction SilentlyContinue

if (-not $listeners) {
  Write-Output "nothing listening on :$backendPort"
  exit 0
}

# Not $pid — that name is an automatic read-only variable and assigning it
# throws before anything is stopped.
foreach ($processId in ($listeners.OwningProcess | Sort-Object -Unique)) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue

  if ($process) {
    Write-Output "stopping $($process.ProcessName) (pid $processId)"
    Stop-Process -Id $processId -Force
  }
}
