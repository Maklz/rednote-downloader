@echo off
setlocal
cd /d "%~dp0"

title RedNote Downloader

echo ============================================
echo   RedNote Downloader
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on this machine.
  echo         Install it from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "src\server.js" (
  echo [ERROR] src\server.js is missing.
  echo         Keep this file in the project folder next to package.json.
  echo.
  pause
  exit /b 1
)

rem Set PORT before running this file to use a different one.
if "%PORT%"=="" set "PORT=3010"
set "URL=http://127.0.0.1:%PORT%/review"

rem yt-dlp needs ffmpeg to merge the separate video and audio streams that the
rem better formats come in. Point this at the folder holding ffmpeg.exe.
if "%FFMPEG_LOCATION%"=="" set "FFMPEG_LOCATION=D:\Creation\FF13"

echo Opening %URL% in your browser once the server is up.
echo Press Ctrl+C in this window to stop the server.
echo.

rem Give the server a moment to bind the port before the browser asks for it.
start "" cmd /c "timeout /t 3 /nobreak >nul & start """" %URL%"

node src/server.js

echo.
echo ============================================
echo   Server stopped.
echo ============================================
pause
