@echo off
chcp 936 >nul 2>nul
setlocal
cd /d "%~dp0"
if errorlevel 1 (
  echo [x] 无法进入程序所在目录。
  echo     请把整个文件夹解压到本地磁盘后再双击（不要直接在压缩包里运行）。
  pause
  exit /b 1
)
title 森空岛签到 - 明日方舟 / 终末地
echo ==========================================
echo   森空岛签到（明日方舟 / 终末地）
echo ==========================================
echo.

set "NODE_EXE="
if exist "%~dp0node.exe" set "NODE_EXE=%~dp0node.exe"
if not defined NODE_EXE ( where node >nul 2>nul && set "NODE_EXE=node" )
if not defined NODE_EXE (
  echo [x] 没有找到 Node.js。
  echo     这个压缩包应该自带 node.exe；如果它不见了，请重新下载完整压缩包。
  echo     也可以到 https://nodejs.org/ 装 LTS 版本后再试。
  echo.
  pause
  exit /b 1
)

echo Node.js 版本：
"%NODE_EXE%" -v
if errorlevel 1 (
  echo.
  echo [x] Node.js 找到了，但运行失败（可能文件损坏或权限问题）。
  echo     请重新下载完整压缩包，或到 https://nodejs.org/ 装 LTS 版本。
  pause
  exit /b 1
)
set "NMAJOR="
for /f "tokens=1 delims=." %%a in ('"%NODE_EXE%" -v 2^>nul') do set "NMAJOR=%%a"
if not defined NMAJOR goto skipver
set "NMAJOR=%NMAJOR:v=%"
if %NMAJOR% LSS 18 (
  echo.
  echo [x] Node.js 版本太低，需要 18 或更高。
  pause
  exit /b 1
)
:skipver
echo.

set "HAS_TOKEN="
if exist "tokens.txt" (
  for /f "usebackq eol=# delims=" %%L in ("tokens.txt") do set "HAS_TOKEN=1"
)
if not defined HAS_TOKEN (
  echo [1/2] 还没有配置 token。
  echo     请先把 token 复制到剪贴板，然后按任意键导入（不会显示内容）。
  echo     注意：只认一个 token（单行）；导入会覆盖 tokens.txt 现有内容。
  echo     如果剪贴板里是整段 JSON 或多行，请只复制 data.content 那一串再试。
  echo     不放心的话，可以用记事本打开 tokens.txt 手动粘贴，保存后再双击。
  echo.
  echo     token 获取方法：浏览器登录 https://www.skland.com/ ，然后打开
  echo     https://web-api.skland.com/account/info/hg
  echo     复制返回 JSON 里 data.content 那一整串。
  echo.
  pause >nul
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $t=(Get-Clipboard -Raw); if($t){$t=$t.Trim()}; $t=$t -replace '^\uFEFF',''; if(-not $t){ throw 1 }; if($t -match '[\r\n]'){ throw 4 }; if($t -match '[\x00-\x1F\x7F]'){ throw 5 }; if($t.Length -gt 4096){ throw 2 }; [IO.File]::WriteAllText('tokens.txt',$t,(New-Object Text.UTF8Encoding($false))); $f=Get-Item 'tokens.txt'; if(-not $f -or $f.Length -eq 0){ throw 3 }; exit 0 } catch { exit 1 }"
  if errorlevel 1 (
    echo [x] 导入失败：剪贴板是空的、有多行或非法字符，或者没有权限写入。
    echo     可以用记事本打开 tokens.txt，把 token 粘进去，保存后再双击本文件。
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
"%NODE_EXE%" src\cli.js --token-file tokens.txt
set "CODE=%errorlevel%"
chcp 936 >nul 2>nul
echo.
if "%CODE%"=="0" echo 完成：全部成功或已签。
if "%CODE%"=="1" echo 有角色或账号失败，或者运行时出错（看上面的输出）。
if "%CODE%"=="2" echo 参数或输入有问题（token 格式对不上？）。
echo 退出码：%CODE%
echo.
echo 窗口会停在这里，按任意键关闭。
pause >nul
exit /b %CODE%
