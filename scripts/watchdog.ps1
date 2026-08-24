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
#   powershell -ExecutionPolicy Bypass -File scripts\watchdog.ps1

$backend = "C:\Users\Pangwoo\date-platform-backend"
$frontend = "C:\Users\Pangwoo\date-platform"
$log = "$backend\watchdog.log"

function Write-Line($text) {
  $line = "{0}  {1}" -f (Get-Date -Format "MM-dd HH:mm:ss"), $text
  Add-Content -Path $log -Value $line
}

function Test-Endpoint($url, $timeout) {
  try {
    $code = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeout).StatusCode
    return $code -eq 200
  } catch { return $false }
}

Write-Line "watchdog on"

while ($true) {
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
