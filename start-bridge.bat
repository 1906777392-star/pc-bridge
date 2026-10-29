@echo off
chcp 65001 >nul
title pc-bridge

REM ===== 改这两行 =====
set BRIDGE_TOKEN=把这里换成你自己生成的随机串
set BRIDGE_ROOT=D:\anim
REM ====================

set BRIDGE_PORT=8787
timeout /t 3 /nobreak >nul
node "%~dp0server.mjs"

echo.
echo pc-bridge 已退出，10 秒后关闭窗口
pause
