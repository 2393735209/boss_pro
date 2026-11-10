@echo off
chcp 65001 >nul
title BOSS DOM Probe
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] Please run start.bat first to install dependencies.
  pause
  exit /b 1
)

echo Reading BOSS page structure, auto-close in about 10 seconds...
echo.
call "node_modules\.bin\electron.cmd" . --probe
echo.
echo ========================================
echo  Screenshot everything above and send it
echo ========================================
pause
