@echo off
setlocal
cd /d "%~dp0"
title Skland Check-in
echo ============================================
echo   Skland check-in  (Arknights / Endfield)
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js was not found.
  echo     Please install Node.js LTS from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

echo Node.js:
node -v
echo.

set "HAS_TOKEN="
if exist "tokens.txt" (
  for /f "usebackq eol=# delims=" %%L in ("tokens.txt") do set "HAS_TOKEN=1"
)
if not defined HAS_TOKEN (
  echo [1/2] No token yet.
  echo     Copy your skland token, then press any key to read it from clipboard ^(it will not be shown^).
  echo     How to get it: log in at https://www.skland.com/ then open
  echo     https://web-api.skland.com/account/info/hg
  echo     and copy the whole string in data.content.
  echo.
  pause >nul
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=(Get-Clipboard -Raw); if($t){$t=$t.Trim()}; if(-not $t){exit 1}; [IO.File]::WriteAllText('tokens.txt',$t,(New-Object Text.UTF8Encoding($false))); exit 0"
  if errorlevel 1 (
    echo [x] Clipboard is empty or tokens.txt cannot be written.
    echo     You can also open tokens.txt in Notepad, paste the token, save, and run this file again.
    echo.
    pause
    exit /b 1
  )
  echo     Token saved.
  echo.
)

echo [2/2] Checking in...
echo.
node src\cli.js --token-file tokens.txt
set "CODE=%errorlevel%"
echo.
echo Exit code: %CODE%
if "%CODE%"=="0" echo Done: all roles succeeded or already checked in.
if "%CODE%"=="1" echo Some role or account failed, or an error occurred. See output above.
if "%CODE%"=="2" echo Bad arguments or input format.
echo.
pause >nul
exit /b %CODE%
