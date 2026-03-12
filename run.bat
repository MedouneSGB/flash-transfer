@echo off
echo ⚡ Flash Transfer - Demarrage...
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64 2>nul
set PATH=C:\Users\MSGB\.cargo\bin;%PATH%
cd /d "%~dp0"
npx tauri dev
