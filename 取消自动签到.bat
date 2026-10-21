@echo off
chcp 936 >nul 2>nul
setlocal
cd /d "%~dp0"
set "NODE_EXE=%~dp0node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
chcp 65001 >nul
"%NODE_EXE%" src\cli.js --uninstall-task
set "CODE=%errorlevel%"
chcp 936 >nul 2>nul
echo.
pause >nul
exit /b %CODE%
