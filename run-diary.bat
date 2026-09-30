@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
echo ==== %date% %time% ==== >> logs\scheduler.log
set HEADLESS=true
"C:\Program Files\nodejs\node.exe" fetch-diary.js >> logs\scheduler.log 2>&1
echo. >> logs\scheduler.log
