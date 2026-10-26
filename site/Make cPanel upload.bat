@echo off
setlocal
cd /d "%~dp0"
title Make cPanel upload
echo.
echo   Making the upload file for cPanel (about 2 minutes)...
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed. Double-click Start Whizperz.bat first.
  pause
  goto end
)
if "%SITE_URL%"=="" set SITE_URL=https://tours.whizperzpizza.co.ke
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 goto failed
node scripts\make-cpanel-package.mjs
if errorlevel 1 goto failed
echo   Done. The file whizperz-cpanel.tar.gz is in this folder.
explorer /select,"%~dp0whizperz-cpanel.tar.gz"
pause
goto end
:failed
echo.
echo   Something went wrong above. Take a screenshot of this window and send it to your developer.
pause
:end
endlocal
