@echo off
chcp 936 >nul 2>nul
setlocal
cd /d "%~dp0"
set "NODE_EXE=%~dp0node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
echo ==========================================
echo   设置每天自动签到
echo ==========================================
echo.
echo 设置后，电脑开着、这个 Windows 用户已登录时，每天会自动跑一次签到。
echo.
set /p "T=每天几点跑？直接回车用 08:00（24 小时制，例如 07:30）："
if not defined T set "T=08:00"
echo.
chcp 65001 >nul
"%NODE_EXE%" src\cli.js --install-task %T%
chcp 936 >nul 2>nul
echo.
pause >nul
