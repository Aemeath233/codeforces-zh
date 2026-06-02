@echo off
title Codeforces AI Translation Mirror - One-Click Starter

echo =======================================================
echo     Codeforces AI Translation Mirror - One-Click Launcher
echo =======================================================
echo.
echo [INFO] Launching startup controller start.py, please wait...
echo.

python start.py

if errorlevel 1 (
    echo.
    echo [WARNING] Startup script exited with an error.
) else (
    echo.
    echo [SUCCESS] Startup script finished execution.
)

pause
