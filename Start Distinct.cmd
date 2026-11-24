@echo off
title Distinct (keep this window open; minimise it)
cd /d "%~dp0"
rem Open the page once the assistant is ready (if it's already running, just open the page).
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:7777/ -TimeoutSec 2 | Out-Null; Start-Process http://127.0.0.1:7777; exit 1 } catch { exit 0 }"
if errorlevel 1 exit /b 0
rem Company networks: trust Windows' certificates, use the system proxy, and an extra company certificate if one was added in Settings.
if exist "%~dp0data\company-ca.pem" set "NODE_EXTRA_CA_CERTS=%~dp0data\company-ca.pem"
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 3; Start-Process http://127.0.0.1:7777"
node --use-system-ca --use-env-proxy src\main.ts
echo.
echo Distinct stopped. Press any key to close.
pause >nul
