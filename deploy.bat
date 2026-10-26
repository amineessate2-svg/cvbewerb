@echo off
title Deploiement AWS Auto-CV
cd /d "%~dp0"
echo ====================================================
echo   Mise a jour du serveur AWS (Auto-CV Pro)
echo ====================================================
echo.

set KEY="C:\Users\amine\amine.pem"
set SERVER=ubuntu@13.60.254.238

echo [1/5] Envoi de server.js, scraper et package.json vers AWS...
scp -i %KEY% server.js %SERVER%:~/cvbewebe/server.js
scp -i %KEY% scraper/platforms_service.js %SERVER%:~/cvbewebe/scraper/platforms_service.js
scp -i %KEY% package.json %SERVER%:~/cvbewebe/package.json
if %ERRORLEVEL% NEQ 0 (
    echo [ERREUR] Echec du transfert de server.js, scraper ou package.json
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [2/5] Verification de data/applications.json...
scp -i %KEY% data/applications.json %SERVER%:~/cvbewebe/data/applications.json

echo.
echo [3/5] Envoi de public/index.html vers AWS...
scp -i %KEY% public/index.html %SERVER%:~/cvbewebe/public/index.html
if %ERRORLEVEL% NEQ 0 (
    echo [ERREUR] Echec du transfert de index.html
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [4/5] Envoi des images d'arriere-plan vers AWS...
scp -i %KEY% public/login_bg.jpg public/app_cyber_bg.jpg public/germany_reichstag_flag.png public/germany_cologne_cathedral.jpg public/germany_hero.jpg %SERVER%:~/cvbewebe/public/
if %ERRORLEVEL% NEQ 0 (
    echo [AVERTISSEMENT] Erreur lors du transfert de certaines images.
)

echo.
echo [5/5] Installation des dependances et redemarrage PM2...
ssh -i %KEY% %SERVER% "cd ~/cvbewebe && npm install --omit=dev && pm2 restart autocv || pm2 start server.js --name autocv && pm2 status"

echo.
echo ====================================================
echo   [OK] Mise a jour terminee avec succes !
echo   Site en ligne : https://ausbildungautobewerbung.help
echo ====================================================
pause
