@echo off
setlocal
cd /d "%~dp0"
title Babyz Pizza - local data server

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this PC.
  echo   Install it once from https://nodejs.org  ^(LTS^), then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting the Babyz Pizza local data server...
echo   The site will open at http://localhost:8787 in a moment.
echo   Keep this window open while you add orders. Press Ctrl+C to stop.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8787'"

node "%~dp0server.js"

echo.
echo   Server stopped.
pause
