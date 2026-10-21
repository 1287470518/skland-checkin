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
echo 默认每天 08:00 跑一次（电脑开着、这个 Windows 用户已登录时）。
echo 想换时间：在命令行运行  node src\cli.js --install-task 07:30
echo.
chcp 65001 >nul
"%NODE_EXE%" src\cli.js --install-task 08:00
set "CODE=%errorlevel%"
chcp 936 >nul 2>nul
set "CODE=%errorlevel%"
echo.
pause >nul
exit /b %CODE%
