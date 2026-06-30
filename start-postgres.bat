@echo off
REM Starts the local PostgreSQL server (installed on D:). Double-click to run.
"D:\PostgreSQL\pgsql\bin\pg_ctl" -D "D:\PostgreSQL\data" -l "D:\PostgreSQL\logfile.txt" start
echo.
echo PostgreSQL should now be running on localhost:5432
pause
