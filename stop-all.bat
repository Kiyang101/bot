@echo off
title Megu Shutdown
echo ============================================
echo   Stopping the Megu stack
echo ============================================
echo.

echo [1/2] Stopping bot and dashboard...
REM Kill any node process launched from this project folder (bot + dashboard).
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*discord-bot*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
REM Close the leftover windows by title (best effort).
taskkill /FI "WINDOWTITLE eq Megu Bot*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Megu Dashboard*" /T /F >nul 2>&1

echo [2/2] Stopping PostgreSQL...
"D:\PostgreSQL\pgsql\bin\pg_ctl" -D "D:\PostgreSQL\data" stop

echo.
echo All stopped.
timeout /t 4 >nul
