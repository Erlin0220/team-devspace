@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1" -Mode Repair -InstallPath "%~dp0" -ManifestPath "%~dp0release-manifest.json" -OfflineRoot "%~1"
echo.
pause
