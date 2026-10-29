@echo off
setlocal
cd /d "%~dp0"
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" "%~dp0"
) else (
  echo Electron is not installed. Run: npm install
  pause
)
