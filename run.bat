@echo off
REM Arranca Spitifo: backend en 127.0.0.1:8000
REM Autocontenido: se posiciona en la carpeta del propio .bat (no depende de
REM rutas fijas ni de nada en Temp), y usa el .venv del repo.

setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [spitifo] No encuentro .venv\Scripts\python.exe en "%~dp0".
  echo [spitifo] Crealo con:  python -m venv .venv
  echo [spitifo]           y luego:  .venv\Scripts\pip install -r requirements.txt
  pause
  exit /b 1
)

REM La fuente de YouTube es la que mas se usa: sin esto el server arranca sin
REM ella y el modo "matched" no encuentra descargas enteras.
set YTDLP_ENABLED=1

echo [spitifo] Sirviendo en http://127.0.0.1:8000  (YTDLP_ENABLED=1)
.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
endlocal
