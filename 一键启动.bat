@echo off
title Codeforces AI Translation Mirror - One-Click Starter

echo =======================================================
echo     Codeforces AI Translation Mirror - One-Click Launcher
echo =======================================================
echo.

:: 1. Check Python Environment
python --version >nul 2>&1
if %errorlevel% equ 0 (
    set PYTHON_CMD=python
    goto python_found
)

py --version >nul 2>&1
if %errorlevel% equ 0 (
    set PYTHON_CMD=py
    goto python_found
)

echo [INFO] Python not found in system PATH. Attempting automatic installation...
where winget >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] winget found. Installing Python 3.11 silently...
    winget install Python.Python.3.11 --silent --accept-source-agreements --accept-package-agreements
    if %errorlevel% equ 0 (
        echo [SUCCESS] Python 3.11 installed successfully! Waiting for path refresh...
        timeout /t 3 >nul
        python --version >nul 2>&1
        if %errorlevel% equ 0 (
            set PYTHON_CMD=python
            goto python_found
        )
        py --version >nul 2>&1
        if %errorlevel% equ 0 (
            set PYTHON_CMD=py
            goto python_found
        )
    )
)

echo [ERROR] Python is not installed or not in PATH.
echo Please download and install Python 3.8+ manually (make sure to check "Add Python to PATH"):
echo https://www.python.org/downloads/
echo.
pause
exit /b 1

:python_found
echo [SUCCESS] Python environment detected: %PYTHON_CMD%

:: 2. Check and Fix pip
%PYTHON_CMD% -m pip --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARNING] pip not found. Attempting to install pip...
    %PYTHON_CMD% -m ensurepip --default-pip >nul 2>&1
    if %errorlevel% neq 0 (
        echo [INFO] ensurepip failed. Downloading get-pip.py...
        powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('https://bootstrap.pypa.io/get-pip.py', 'get-pip.py')" >nul 2>&1
        if exist get-pip.py (
            %PYTHON_CMD% get-pip.py --quiet
            del get-pip.py
        ) else (
            echo [ERROR] Failed to download pip. Please install pip manually.
            pause
            exit /b 1
        )
    )
    echo [SUCCESS] pip installed/repaired successfully!
)

:: 3. Check and Fix Node.js (npm is required for frontend)
npm -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARNING] Node.js/npm not found. Node.js is required for the frontend.
    echo Attempting to install Node.js LTS silently...
    where winget >nul 2>&1
    if %errorlevel% equ 0 (
        echo [INFO] Using winget to install Node.js LTS, please wait...
        winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
        if %errorlevel% equ 0 (
            echo.
            echo [SUCCESS] Node.js LTS installed successfully!
            echo [IMPORTANT] Please close this window and double-click "一键启动.bat" again to refresh path!
            echo.
            pause
            exit /b 0
        )
    )
    echo [ERROR] Node.js could not be installed automatically. Please install it manually (LTS recommended):
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [SUCCESS] Node.js/npm environment is ready.
echo [INFO] Launching startup controller start.py, please wait...
echo.

:: 4. Call main python script
%PYTHON_CMD% start.py

if %errorlevel% neq 0 (
    echo.
    echo [WARNING] Startup script exited with an error.
    pause
)
