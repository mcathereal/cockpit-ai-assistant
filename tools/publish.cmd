@echo off
rem Sicher veroeffentlichen: Review -> Commit -> Push (optional Tag).
rem Beispiel: tools\publish.cmd "feat: neue Funktion" -Tag
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" -Message %*
exit /b %ERRORLEVEL%