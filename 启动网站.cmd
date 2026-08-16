@echo off
cd /d "%~dp0"
start "admission-agent" /min node --env-file=.env server.mjs
timeout /t 2 /nobreak >nul
start "" http://localhost:4173/
