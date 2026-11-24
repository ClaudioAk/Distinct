@echo off
setlocal
title Install Distinct
cd /d "%~dp0"
echo.
echo   ============================================
echo     Distinct - your private assistant
echo   ============================================
echo.

rem 1. Node.js (the engine Distinct runs on), installed with Windows' own installer
set "NODE_OK="
where node >nul 2>nul && node -e "process.exit(+process.versions.node.split('.')[0]>=24?0:1)" && set "NODE_OK=1"
if not defined NODE_OK (
  echo   Installing Node.js ... this can take a few minutes.
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)
where node >nul 2>nul || (
  echo.
  echo   Could not install Node.js automatically.
  echo   Please install it from https://nodejs.org ^(LTS^), then run this file again.
  pause
  exit /b 1
)

rem 2. Distinct's parts
echo   Getting Distinct ready ...
call npm install --omit=dev --no-fund --no-audit >nul
if errorlevel 1 (
  echo   Something went wrong while downloading Distinct's parts. Check the internet connection and try again.
  pause
  exit /b 1
)

rem 3. Desktop shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Distinct.lnk'); $l.TargetPath='%~dp0Start Distinct.cmd'; $l.WorkingDirectory='%~dp0'; $l.WindowStyle=7; $l.IconLocation='%SystemRoot%\System32\imageres.dll,77'; $l.Description='Start Distinct'; $l.Save()"
echo   Added "Distinct" to your desktop.

rem 4. Start with Windows (optional)
echo.
choice /c YN /m "  Start Distinct automatically when you turn on the PC"
if errorlevel 2 goto run
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut([Environment]::GetFolderPath('Startup')+'\Distinct.lnk'); $l.TargetPath='%~dp0Start Distinct.cmd'; $l.WorkingDirectory='%~dp0'; $l.WindowStyle=7; $l.Save()"
echo   Distinct will start with Windows.

:run
echo.
echo   All done! Opening Distinct ...
start "" /min "%~dp0Start Distinct.cmd"
timeout /t 3 >nul
