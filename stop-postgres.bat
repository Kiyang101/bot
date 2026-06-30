@echo off
REM Stops the local PostgreSQL server. Double-click to run.
"D:\PostgreSQL\pgsql\bin\pg_ctl" -D "D:\PostgreSQL\data" stop
echo.
pause
