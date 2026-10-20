@echo off
setlocal
cd /d "%~dp0"
title 森空岛签到 - 明日方舟 / 终末地
echo ==========================================
echo   森空岛签到（明日方舟 / 终末地）
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 没有找到 Node.js。
  echo     请先到 https://nodejs.org/ 下载 LTS 版本安装。
  echo     装好后再双击本文件。
  echo.
  pause
  exit /b 1
)

echo Node.js 版本：
node -v
echo.

set "HAS_TOKEN="
if exist "tokens.txt" (
  for /f "usebackq eol=# delims=" %%L in ("tokens.txt") do set "HAS_TOKEN=1"
)
if not defined HAS_TOKEN (
  echo [1/2] 还没有配置 token。
  echo     请先复制你的 token，然后按任意键，我从剪贴板读进来（不会显示内容）。
  echo.
  echo     token 获取方法：浏览器登录 https://www.skland.com/ ，然后打开
  echo     https://web-api.skland.com/account/info/hg
  echo     复制返回 JSON 里 data.content 那一整串。
  echo.
  pause >nul
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=(Get-Clipboard -Raw); if($t){$t=$t.Trim()}; if(-not $t){exit 1}; [IO.File]::WriteAllText('tokens.txt',$t,(New-Object Text.UTF8Encoding($false))); exit 0"
  if errorlevel 1 (
    echo [x] 剪贴板是空的，或者没有权限写入。
    echo     也可以用记事本打开 tokens.txt，把 token 粘进去，保存后再双击本文件。
    echo.
    pause
    exit /b 1
  )
  echo     token 已保存（不会显示内容）。
  echo.
)

echo [2/2] 开始签到……
echo.
chcp 65001 >nul
node src\cli.js --token-file tokens.txt
set "CODE=%errorlevel%"
chcp 936 >nul
echo.
if "%CODE%"=="0" echo 完成：全部成功或已签。
if "%CODE%"=="1" echo 有角色或账号失败，或者运行时出错（看上面的输出）。
if "%CODE%"=="2" echo 参数或输入有问题（token 格式对不上？）。
echo 退出码：%CODE%
echo.
echo 窗口会停在这里，按任意键关闭。
pause >nul
exit /b %CODE%
