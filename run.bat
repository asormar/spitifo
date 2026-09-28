@echo off
REM Arranca Spitifo: backend en :8000
cd /d C:\Users\Alejandro\Desktop\PROYECTOS\spitifo
.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
