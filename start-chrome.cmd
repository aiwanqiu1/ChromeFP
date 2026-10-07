@echo off
chcp 65001 >nul
title Chrome Fingerprint Launcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

echo.
echo   Aligning fingerprint to current egress IP, then launching Chrome...
echo   First run may take 5-20 seconds. Keep your proxy software running.
echo.

node "%~dp0fp-browser.mjs" %*
set "EC=%ERRORLEVEL%"

echo.
if not "%EC%"=="0" echo   Launcher exited with code %EC%. See the messages above.
pause
exit /b %EC%

:NONODE
echo.
echo   [ERROR] node was not found on PATH.
echo   Install Node.js, or add its folder to PATH, then run this file again.
echo.
pause
exit /b 1
