# 백엔드와 프론트가 죽으면 다시 띄웁니다.
#
# 두 번 겪고 만들었습니다. 백엔드는 수집기를 겸하고 있어서 죽으면 그 시간의
# 분봉이 영영 없습니다 -- 나중에 받아올 방법이 없는 유일한 데이터입니다.
# 프론트는 Next dev가 힙을 계속 먹다 두 번 쓰러졌고, 그래서 지금은 프로덕션
# 빌드를 `npm run start`로 서빙합니다.
#
# 응답 여부로 판정합니다. 프로세스가 살아 있는지만 보면 멈춘 채 살아 있는 경우를
# 놓칩니다.
#
# 로그온할 때 자동으로 뜹니다(HKCU\...\Run의 "DATE watchdog"). 수동으로 돌리려면:
#
#   powershell -ExecutionPolicy Bypass -File scripts\watchdog.ps1

$backend = "C:\Users\Pangwoo\date-platform-backend"
$frontend = "C:\Users\Pangwoo\date-platform"
$log = "$backend\watchdog.log"
$container = "date-platform-postgres"

function Write-Line($text) {
  $line = "{0}  {1}" -f (Get-Date -Format "MM-dd HH:mm:ss"), $text
  Add-Content -Path $log -Value $line
}

function Test-Endpoint($url, $timeout) {
  try {
    return (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeout).StatusCode -eq 200
  } catch { return $false }
}

# 백엔드는 DB 없이는 살아날 수 없습니다. 부팅 직후에는 도커가 아직 안 떠 있으므로,
# 이걸 확인하지 않으면 매분 백엔드를 띄웠다 죽이기만 반복합니다.
function Test-Database {
  try {
    $state = docker inspect $container --format '{{.State.Running}}' 2>$null
    return $state -eq "true"
  } catch { return $false }
}

# 로그온 시 자동 실행이라 손으로 한 번 더 돌리면 둘이 겹칩니다. 서로 상대를
# 재시작하며 싸우게 되므로 먼저 뜬 쪽만 남깁니다.
#
# 커맨드라인으로 찾으면 안 됩니다 -- 이 스크립트를 띄우는 셸의 커맨드라인에도
# watchdog.ps1이 들어 있어서, 자기를 띄운 부모를 "이미 도는 워치독"으로 오인하고
# 곧바로 종료합니다. 실제로 그렇게 두 번 죽었습니다. PID를 파일에 적어 둡니다.
$pidFile = "$backend\watchdog.pid"

if (Test-Path $pidFile) {
  $prior = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  $alive = if ($prior) { Get-Process -Id $prior -ErrorAction SilentlyContinue } else { $null }

  if ($alive -and $alive.ProcessName -match "powershell|pwsh") {
    Write-Line "another watchdog is already running ($prior) - exiting"
    exit
  }
}

Set-Content -Path $pidFile -Value $PID
Write-Line "watchdog on (pid $PID)"

while ($true) {
  if (-not (Test-Database)) {
    Write-Line "database not up yet - waiting"
    Start-Sleep -Seconds 30
    continue
  }

  # 백엔드 먼저. 프론트가 이걸 부르므로 순서가 중요합니다.
  if (-not (Test-Endpoint "http://localhost:4010/api/market-board" 120)) {
    Write-Line "backend down - restarting"
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like "*src/server.mjs*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 3
    Start-Process -FilePath "node" -ArgumentList "src/server.mjs" -WorkingDirectory $backend `
      -RedirectStandardOutput "$backend\collector.log" -RedirectStandardError "$backend\collector.err.log" `
      -WindowStyle Hidden
    Start-Sleep -Seconds 20
  }

  if (-not (Test-Endpoint "http://localhost:3000/" 120)) {
    Write-Line "frontend down - restarting"
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like "*next*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 3
    Start-Process -FilePath "npm.cmd" -ArgumentList "run","start" -WorkingDirectory $frontend `
      -RedirectStandardOutput "$frontend\web.log" -RedirectStandardError "$frontend\web.err.log" `
      -WindowStyle Hidden
    Start-Sleep -Seconds 15
  }

  Start-Sleep -Seconds 60
}
