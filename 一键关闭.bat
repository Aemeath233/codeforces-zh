@echo off
title Codeforces AI Translation Mirror - Stop Services
chcp 65001 >nul

echo =======================================================
echo     Codeforces AI 智能翻译镜像站 - 关闭后台服务
echo =======================================================
echo.

set found=0

echo [信息] 正在检测并关闭后端翻译服务 (端口 8000)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr LISTENING ^| findstr :8000') do (
    taskkill /F /PID %%a >nul 2>&1
    echo [成功] 已关闭后端服务进程 (PID: %%a)
    set found=1
)

echo.
echo [信息] 正在检测并关闭前端静态服务 (端口 5173)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr LISTENING ^| findstr :5173') do (
    taskkill /F /PID %%a >nul 2>&1
    echo [成功] 已关闭前端服务进程 (PID: %%a)
    set found=1
)

echo.
if %found%==1 (
    echo [成功] 镜像站所有后台服务已安全关闭！
) else (
    echo [提示] 未检测到正在运行的镜像站后台服务。
)

echo.
echo 提示：窗口将在 3 秒后自动关闭...
timeout /t 3 >nul
