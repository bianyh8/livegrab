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
rem 已安装 ffmpeg 8.1 于 D:\20-软件工具\00-免安装版\ffmpeg-8.1-essentials_build\bin（机器级 PATH 已包含）；
rem 此处作为 PATH 未刷新生效（新开 cmd 前）时的显式回退，且排在旧版 EVCapture 2019 构建之前。
rem 注意：LiveGrab 的录制参数依赖 ffmpeg 4.3+，EVCapture 自带的 2019 构建不兼容，仅作最后兜底。
where ffmpeg >nul 2>nul
if errorlevel 1 (
  if exist "D:\20-软件工具\00-免安装版\ffmpeg-8.1-essentials_build\bin\ffmpeg.exe" (
    set "FFMPEG_PATH=D:\20-软件工具\00-免安装版\ffmpeg-8.1-essentials_build\bin\ffmpeg.exe"
    set "FFPROBE_PATH=D:\20-软件工具\00-免安装版\ffmpeg-8.1-essentials_build\bin\ffprobe.exe"
  ) else (
    if exist "C:\Program Files\EVCapture\ffmpeg.exe" (
      set FFMPEG_PATH=C:\Program Files\EVCapture\ffmpeg.exe
      set FFPROBE_PATH=C:\Program Files\EVCapture\ffprobe.exe
    )
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
