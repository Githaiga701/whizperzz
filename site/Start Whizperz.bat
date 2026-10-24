@echo off
setlocal
cd /d "%~dp0"
title Whizperz website
echo.
echo   Whizperz website
echo   ================
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "const [a,b,c]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&(b>23||(b===23&&c>=4)))?0:1)"
if errorlevel 1 goto oldnode

echo   Getting everything ready. The first time takes a few minutes...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 goto failed

echo   Building the site...
call npm run build:site --silent
if errorlevel 1 goto failed

echo.
echo   The site is starting. Your browser will open the admin in a few seconds.
echo   Website: http://localhost:4321
echo   Admin:   http://localhost:4321/admin/
echo.
echo   Keep this window open while you use the site. Close it to stop.
echo.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 5; Start-Process 'http://localhost:4321/admin/'"
call npm start --silent
goto end

:nonode
echo   Node.js is not installed on this computer.
echo   The download page will open. Install the LTS version, then double-click this file again.
start "" https://nodejs.org/en/download
pause
goto end

:oldnode
echo   This computer's Node.js is too old. Version 22.23.4 or newer is needed.
echo   The download page will open. Install the LTS version, then double-click this file again.
start "" https://nodejs.org/en/download
pause
goto end

:failed
echo.
echo   Something went wrong above. Take a screenshot of this window and send it to your developer.
pause

:end
endlocal
