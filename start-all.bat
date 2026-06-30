@echo off
title Megu Launcher
echo ============================================
echo   Starting the Megu stack (DB + bot + web)
echo ============================================
echo.

echo [1/3] Starting PostgreSQL...
"D:\PostgreSQL\pgsql\bin\pg_ctl" -D "D:\PostgreSQL\data" -l "D:\PostgreSQL\logfile.txt" -w start

echo [2/3] Starting the bot (opens its own window)...
start "Megu Bot" /d "%~dp0" cmd /k "npm start"

echo [3/3] Starting the dashboard (opens its own window)...
start "Megu Dashboard" /d "%~dp0" cmd /k "npm run dev --workspace dashboard"

echo.
echo Done! The bot and dashboard each opened in their own window.
echo   Dashboard:  http://localhost:3000
echo.
echo Closing this launcher in a few seconds (the other windows stay open)...
timeout /t 6 >nul
