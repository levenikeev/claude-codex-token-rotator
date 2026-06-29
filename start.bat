@echo off
title Claude Token Rotator
cd /d "%~dp0"
:loop
node server.js
echo.
echo [rotator] process exited, restarting in 3s... (Ctrl+C to stop)
timeout /t 3 /nobreak >nul
goto loop
