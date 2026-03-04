@echo off
title Chatbot Peliculas Brasil
color 0A
cls

echo.
echo  ================================================
echo   Chatbot Peliculas Brasil v1.0
echo   Instaladores de Insulfilm - Joao Pessoa/PB
echo  ================================================
echo.

:: Ir para a pasta do script
cd /d "%~dp0"

:: Verificar Node.js
echo  Verificando Node.js...
node --version > nul 2>&1
if errorlevel 1 (
    echo.
    echo  ERRO: Node.js nao encontrado!
    echo.
    echo  Por favor, baixe e instale o Node.js LTS em:
    echo  https://nodejs.org
    echo.
    echo  Apos instalar, feche e abra este arquivo novamente.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  Node.js %NODE_VER% encontrado. OK!
echo.

:: Verificar arquivo .env
if not exist ".env" (
    echo  AVISO: Arquivo .env nao encontrado!
    echo  Copiando .env.example para .env...
    copy ".env.example" ".env" > nul
    echo.
    echo  IMPORTANTE: Abra o arquivo .env em um editor de
    echo  texto e preencha sua GROQ_API_KEY e OWNER_NUMBER
    echo  antes de continuar!
    echo.
    pause
    start notepad .env
    pause
)

:: Instalar dependencias se necessario
if not exist "node_modules" (
    echo  Instalando dependencias pela primeira vez...
    echo  Isso pode demorar 1-2 minutos, aguarde...
    echo.
    npm install
    if errorlevel 1 (
        echo.
        echo  ERRO ao instalar dependencias!
        echo  Verifique sua conexao com a internet.
        pause
        exit /b 1
    )
    echo.
    echo  Dependencias instaladas com sucesso!
    echo.
)

:: Abrir navegador apos 4 segundos (em background)
echo  Abrindo painel no navegador em 4 segundos...
start "" cmd /c "timeout /t 4 /nobreak > nul && start http://localhost:3000"

echo.
echo  Iniciando servidor...
echo  Para parar o bot, feche esta janela.
echo.
echo  ================================================
echo   Painel: http://localhost:3000
echo  ================================================
echo.

:: Iniciar Node.js
node index.js

echo.
echo  Servidor parado. Pressione qualquer tecla para fechar.
pause > nul
