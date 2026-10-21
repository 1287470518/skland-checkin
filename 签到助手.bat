@echo off
chcp 936 >nul 2>nul
setlocal
cd /d "%~dp0"
set "NODE_EXE=%~dp0node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
chcp 65001 >nul
"%NODE_EXE%" src\ui-server.mjs
set "CODE=%errorlevel%"
chcp 936 >nul 2>nul
echo.
echo 签到助手已退出（按任意键关闭窗口）。
pause >nul
exit /b %CODE%
