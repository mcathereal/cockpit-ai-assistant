@echo off
rem Prueft, ob auf GitHub eine neuere Version liegt als die installierte.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-update.ps1"
if %ERRORLEVEL%==2 echo UPDATE VERFUEGBAR - siehe oben.
exit /b %ERRORLEVEL%