@echo off
rem LiveGrab local run (no Docker needed). Double-click this file or run it in this folder.
rem Open http://127.0.0.1:8080 after it prints the listening line.
setlocal
cd /d "%~dp0"

if "%PORT%"=="" set PORT=8080
if "%RECORD_ROOT%"=="" set RECORD_ROOT=%~dp0data
if "%CONFIG_DIR%"=="" set CONFIG_DIR=%~dp0config
if "%TZ%"=="" set TZ=Asia/Shanghai
rem 版本号不设 LIVEGRAB_VERSION：由 app/server/util.js 启动时读 app/package.json
rem（此前写死 0.1.0 会覆盖动态版本，本地运行一直显示旧版本号）

rem ffmpeg: prefer PATH, else common local installs
where ffmpeg >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\EVCapture\ffmpeg.exe" (
    set FFMPEG_PATH=C:\Program Files\EVCapture\ffmpeg.exe
    set FFPROBE_PATH=C:\Program Files\EVCapture\ffprobe.exe
  )
)

if not exist "%RECORD_ROOT%" mkdir "%RECORD_ROOT%"
if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"

echo [LiveGrab] url   : http://127.0.0.1:%PORT%
echo [LiveGrab] record: %RECORD_ROOT%
echo [LiveGrab] config: %CONFIG_DIR%
echo [LiveGrab] tz    : %TZ%
echo [LiveGrab] stop  : press Ctrl+C
echo.

cd /d "%~dp0app"
node server/server.js
endlocal
