@echo off
title Auto-CV Bulk Sender
cd /d "%~dp0"
echo.
echo ====================================================
echo   Auto-CV Bulk Sender — Menu
echo ====================================================
echo.
echo   [1]  Lancer le serveur  (node server.js)
echo   [2]  Scraper Ausbildung (ausbildung_scraper.cjs)
echo   [3]  Scraper Google Maps (gmaps_scraper.cjs)
echo   [4]  Mise a jour Serveur AWS (Deploy Live)
echo.
set /p CHOIX="Choix (1/2/3/4) : "

if "%CHOIX%"=="1" goto SERVER
if "%CHOIX%"=="2" goto AUSBILDUNG
if "%CHOIX%"=="3" goto GMAPS
if "%CHOIX%"=="4" goto DEPLOY
echo Choix invalide.
pause
goto END

:SERVER
echo.
echo Demarrage du serveur...
node server.js
pause
goto END

:AUSBILDUNG
echo.
echo Demarrage du scraper Ausbildung...
echo Usage: node scraper/ausbildung_scraper.cjs --sector=it --region=Berlin --maxPerQuery=3
echo.
set /p ARGS="Arguments (Entree = lancer sans args) : "
node scraper/ausbildung_scraper.cjs %ARGS%
pause
goto END

:GMAPS
echo.
echo Demarrage du scraper Google Maps...
node scraper/gmaps_scraper.cjs
pause
goto END

:DEPLOY
echo.
call deploy.bat
goto END

:END
