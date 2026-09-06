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
set "URL=http://127.0.0.1:%PORT%"

rem A second copy would fight this one for the port, and Telegram allows only
rem one long-poll per bot token -- both instances would then fail to answer.
netstat -ano | findstr /r /c:"LISTENING" | findstr /c:":%PORT% " >nul
if not errorlevel 1 (
  echo [ERROR] Something is already listening on port %PORT%.
  echo         The bot is probably already running in another window.
  echo         Close it first, or set PORT to a free port.
  echo.
  pause
  exit /b 1
)

echo Opening %URL% in your browser once the server is up.
echo Press Ctrl+C in this window to stop the server.
echo.

rem Give the server a moment to bind the port before the browser asks for it.
start "" cmd /c "timeout /t 3 /nobreak >nul & start """" %URL%"

:run
node src/server.js
set "EXIT_CODE=%ERRORLEVEL%"

rem A clean shutdown exits 0 and stays down. Anything else is a crash -- a lost
rem network, an unhandled error -- and the bot is no use while it is down, so it
rem comes back on its own instead of waiting to be noticed.
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [WARN] Server exited with code %EXIT_CODE%. Restarting in 5 seconds...
  echo        Press Ctrl+C now to stop for good.
  timeout /t 5 >nul
  goto run
)

echo.
echo ============================================
echo   Server stopped.
echo ============================================
pause
