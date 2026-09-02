@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -Command "$processes = Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' }; $processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required to run Zaparoo Drive Launcher.
  echo Install Node.js from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'node.exe' -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:4317"
