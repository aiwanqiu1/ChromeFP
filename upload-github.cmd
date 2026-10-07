@echo off
chcp 65001 >nul
title ChromeFP GitHub Upload
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0upload-github.ps1" %*
set "UPLOAD_EXIT=%ERRORLEVEL%"

echo.
if not "%UPLOAD_EXIT%"=="0" echo Upload failed. See the message above.
pause
exit /b %UPLOAD_EXIT%
