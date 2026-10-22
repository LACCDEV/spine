@echo off
rem Startet den lokalen Webserver und oeffnet die Seite im Standardbrowser.
rem Kein Node, kein Python, keine Adminrechte noetig. Beenden: Fenster schliessen.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port 8090 -Open
pause
