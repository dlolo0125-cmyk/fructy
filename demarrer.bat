@echo off
setlocal
cd /d "%~dp0"
title SikaPlus - Serveur local

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js est introuvable.
  echo Installe Node.js 22.13 ou superieur depuis https://nodejs.org/
  pause
  exit /b 1
)

if not exist .env (
  if exist .env.example copy .env.example .env >nul
)

echo.
echo === Verification de Node.js ===
node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<22 || (v[0]===22 && v[1]<13)){console.error('Node.js 22.13 minimum requis. Version detectee : '+process.version);process.exit(1)}"
if errorlevel 1 (
  pause
  exit /b 1
)

echo.
echo === Creation du premier administrateur ===
echo Saisis le numero avec indicatif pays, chiffres uniquement.
set /p ADMIN_PHONE=Numero administrateur : 
set /p ADMIN_PASSWORD=Mot de passe administrateur (10 caracteres minimum) : 
if "%ADMIN_PHONE%"=="" (
  echo Le numero est obligatoire.
  pause
  exit /b 1
)
if "%ADMIN_PASSWORD%"=="" (
  echo Le mot de passe est obligatoire.
  pause
  exit /b 1
)

echo.
echo === Demarrage de SikaPlus ===
echo Espace client : http://localhost:3000/
echo Administration : http://localhost:3000/gestion
echo Garder cette fenetre ouverte. Ctrl+C pour arreter.
echo.
set PORT=3000
npm start
echo.
echo Le serveur est arrete.
pause
