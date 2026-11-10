@echo off
chcp 65001 >nul
title BOSS Dry Run Inspector
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [First run] Installing dependencies, about 100MB, please wait...
  echo.
  call npm install --no-audit --no-fund
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo [ERROR] Electron is missing. Check your network and run start.bat again.
  pause
  exit /b 1
)

echo Starting BOSS Dry Run Inspector...
call "node_modules\.bin\electron.cmd" . %*

if errorlevel 1 (
  echo.
  echo [ERROR] App exited abnormally. Screenshot the message above and send it to the assistant.
  pause
)
