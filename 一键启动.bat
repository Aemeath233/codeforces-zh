@echo off
rem -*- coding: utf-8 -*-
chcp 65001 > nul
title Codeforces AI 智能双语翻译镜像站 - 一键启动

echo =======================================================
echo      Codeforces AI 智能双语翻译镜像站 - 一键启动引导器
echo =======================================================
echo.

:: 1. 检测 Python 环境
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

echo [提示] 检测到系统环境变量中未找到 Python。正在尝试自动为您安装...
where winget >nul 2>&1
if %errorlevel% equ 0 (
    echo [信息] 检测到系统支持 winget 包管理器，正在静默安装 Python 3.11...
    winget install Python.Python.3.11 --silent --accept-source-agreements --accept-package-agreements
    if %errorlevel% equ 0 (
        echo [成功] Python 3.11 静默安装成功！正在等待系统环境刷新...
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

echo [错误] 无法自动为您安装 Python，或安装后未检测到 Python 环境变量。
echo 请手动前往官网下载并安装 Python 3.8+ (请务必勾选 "Add Python to PATH" 选项):
echo 🔗 https://www.python.org/downloads/
echo.
pause
exit /b 1

:python_found
echo [成功] 检测到系统 Python 环境：%PYTHON_CMD%

:: 2. 检测并修复 pip
%PYTHON_CMD% -m pip --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [警告] 检测到 Python 未安装 pip 包管理器，正在为您自动下载/修复 pip...
    %PYTHON_CMD% -m ensurepip --default-pip >nul 2>&1
    if %errorlevel% neq 0 (
        echo [信息] ensurepip 失败，正在从官方通道下载 get-pip.py 并进行手动安装...
        powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('https://bootstrap.pypa.io/get-pip.py', 'get-pip.py')" >nul 2>&1
        if exist get-pip.py (
            %PYTHON_CMD% get-pip.py --quiet
            del get-pip.py
        ) else (
            echo [错误] 无法下载 pip 安装脚本，请检查您的网络连接并手动安装 pip。
            pause
            exit /b 1
        )
    )
    echo [成功] pip 安装/修复成功！
)

:: 3. 检测并修复 Node.js 环境 (前端启动需要 npm)
npm -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [警告] 未检测到系统 Node.js 运行环境 (npm 命令不可用)。
    echo 本镜像站的前端服务需要 Node.js 支持，正在尝试自动为您下载并安装...
    where winget >nul 2>&1
    if %errorlevel% equ 0 (
        echo [信息] 正在使用 winget 静默安装 Node.js LTS，这可能需要 1-2 分钟...
        winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
        if %errorlevel% equ 0 (
            echo.
            echo [成功] Node.js LTS 安装成功！
            echo [重要] 由于新安装了 Node.js，需要刷新环境变量。
            echo 请「关闭此终端窗口」，重新双击运行「一键启动.bat」即可！
            echo.
            pause
            exit /b 0
        )
    )
    echo [错误] 无法自动为您安装 Node.js，请手动前往官网下载并安装 (推荐 LTS 版本):
    echo 🔗 https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [成功] 检测到系统 Node.js/npm 环境已就绪。
echo [信息] 正在为您调起主启动脚本 start.py，请稍候...
echo.

:: 4. 调用主脚本
%PYTHON_CMD% start.py

if %errorlevel% neq 0 (
    echo.
    echo [警告] 启动脚本异常退出。
    pause
)
