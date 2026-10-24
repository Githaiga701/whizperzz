@echo off
setlocal
cd /d "%~dp0"
title Whizperz tests
echo.
echo   Checking the Whizperz website. This takes about 3 minutes.
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 goto failed
call npx playwright install chromium
if errorlevel 1 goto failed

call npm run test:all
if errorlevel 1 goto testsfailed

echo.
echo   ALL TESTS PASSED.
echo.
pause
goto end

:testsfailed
echo.
echo   SOME TESTS FAILED. The report will open in your browser.
if exist "playwright-report\index.html" start "" "playwright-report\index.html"
echo.
pause
goto end

:nonode
echo   Node.js is not installed. Double-click "Start Whizperz.bat" first; it will help you install it.
pause
goto end

:failed
echo.
echo   Something went wrong above. Take a screenshot of this window and send it to your developer.
pause

:end
endlocal
