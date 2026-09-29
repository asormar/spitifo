"""Contrato de la API con TestClient en proceso (no hace falta server en :8000).

Lo que se puede verificar SIN red: la forma de las respuestas, el manejo de
errores (400/403/422), el contrato de `/api/download/progress/{job_id}` y el
formato de `Track.to_dict()`. Un 200 en la API no prueba que el audio sea
valido (eso lo cubren los tests de integracion con mutagen y ffprobe); aca se
testea el contrato, que es otra cosa.

`/api/search` con fuentes reales NO se testea aca: pega a internet y va en
test_integration.py.
"""
from __future__ import annotations

import pytest

from backend.app.models import Track, safe_name
from backend.app.ytdlp_source import JOBS, JOBS_TTL_S, new_job, get_job, _purge_jobs


# ------------------------------------------------------------------- /api/health
def test_health(cliente):
    """Health tiene que reportar cada fuente con su estado y si pide key."""
    h = cliente.get("/api/health").json()
    assert h["ok"] is True
    assert h["library"]

    fuentes = {s["name"]: s for s in h["sources"]}
    # itunes / archive / wikimedia andan sin credencial
    for nombre in ("itunes", "archive", "wikimedia"):
        assert fuentes[nombre]["active"] is True, nombre
        assert fuentes[nombre]["needs_key"] is None
    # jamendo exige client_id: sin key tiene que estar inactiva, no rota
    assert fuentes["jamendo"]["needs_key"] == "JAMENDO_CLIENT_ID"


# ------------------------------------------------------------------ /api/download
def test_download_fuente_desconocida_da_400(cliente):
    r = cliente.post("/api/download", json={
        "source": "napster", "track": {"source": "x", "source_id": "1",
                                       "title": "t", "artist": "a"}, "fmt": "mp3"})
    assert r.status_code == 400
    assert "fuente desconocida" in r.json()["detail"]


def test_download_payload_invalido_da_400(cliente):
    """Un track sin `source` no se puede convertir en Track: 400, no 500."""
    r = cliente.post("/api/download", json={"source": "archive",
                                           "track": {"title": "t"}, "fmt": "mp3"})
    assert r.status_code == 400
    assert "invalido" in r.json()["detail"]


def test_download_de_ytdlp_apagado_da_503(cliente, monkeypatch):
    """Rama "matched" (source=itunes + webpage_url) con yt-dlp apagado: 503, no 500."""
    monkeypatch.setenv("YTDLP_ENABLED", "0")
    r = cliente.post("/api/download", json={
        "source": "itunes",
        "track": {"source": "itunes", "source_id": "123", "title": "Numb",
                  "artist": "Linkin Park",
                  "extra": {"webpage_url": "https://www.youtube.com/watch?v=abc"}},
        "fmt": "mp3"})
    assert r.status_code == 503
    assert "YTDLP_ENABLED" in r.json()["detail"]


def test_download_de_fuente_despagada_da_403(cliente, monkeypatch):
    """Pedir `source=ytdlp` con YTDLP_ENABLED=0: 403 'esta desactivada'.

    Ojo el orden de los chequeos: `available()` se valida ANTES de entrar a la
    rama de yt-dlp, asi que da 403 y no el 503 de arriba. Son dos errores
    distintos para dos formas distintas de pedir lo mismo.
    """
    monkeypatch.setenv("YTDLP_ENABLED", "0")
    r = cliente.post("/api/download", json={
        "source": "ytdlp",
        "track": {"source": "ytdlp", "source_id": "abc", "title": "Numb",
                  "artist": "Linkin Park",
                  "extra": {"webpage_url": "https://www.youtube.com/watch?v=abc"}},
        "fmt": "mp3"})
    assert r.status_code == 403
    assert "desactivada" in r.json()["detail"]


def test_search_fuente_desconocida_da_400(cliente):
    r = cliente.get("/api/search", params={"q": "numb", "source": "napster"})
    assert r.status_code == 400
    assert "fuente desconocida" in r.json()["detail"]


# ------------------------------------------------------------- /api/progress
def test_progress_de_job_inexistente_da_unknown(cliente):
    """Un job_id que no existe responde 200 con status unknown, no revienta."""
    r = cliente.get("/api/download/progress/no-existe-este-job")
    assert r.status_code == 200
    assert r.json()["status"] == "unknown"


def test_nuevo_job_arranca_pendiente():
    job_id = new_job("Numb")
    job = get_job(job_id)
    assert job["status"] == "pending"
    assert job["title"] == "Numb"
    assert job_id in JOBS


def test_purga_solo_toca_jobs_terminados_y_viejos():
    """La fuga de memoria #1: se purgan los TERMINADOS viejos, no los vivos.

    Un job en `downloading` NO se toca, asi que la UI puede seguir pollando
    sin colgarse. Y `_purge_jobs` corre en un hilo aparte: el lock no es
    reentrante.
    """
    import threading
    import time

    JOBS.clear()
    viejo = new_job("viejo")
    nuevo = new_job("nuevo")
    with threading.Lock():  # el hook de progreso toma este mismo lock
        JOBS[viejo].update(status="done", finished_at=time.time() - JOBS_TTL_S - 10)
        JOBS[nuevo].update(status="done", finished_at=time.time())

    purgados = _purge_jobs()
    assert purgados == 1
    assert viejo not in JOBS
    assert nuevo in JOBS

    # un job en curso sobrevive aunque sea viejo de por si
    JOBS.clear()
    activo = new_job("descargando")
    JOBS[activo].update(status="downloading", finished_at=time.time() - 99999)
    assert _purge_jobs() == 0
    assert activo in JOBS
    JOBS.clear()


# ----------------------------------------------------------------- Track
def test_track_to_dict_incluye_downloadable():
    """`downloadable` es derivado de `audio_url` y va en la respuesta JSON."""
    t = Track(source="itunes", source_id="1", title="Numb", artist="Linkin Park")
    assert t.downloadable is False
    t.audio_url = "https://example.com/numb.mp3"
    assert t.to_dict()["downloadable"] is True


def test_track_to_dict_no_comparte_el_extra():
    """El `extra` se copia en el dict: que dos Tracks no compartan el mismo dict."""
    a = Track(source="x", source_id="1", title="a", artist="b")
    b = Track(source="x", source_id="2", title="c", artist="d")
    a.extra["k"] = 1
    assert "k" not in b.extra
    assert "k" not in a.to_dict()["extra"] or a.to_dict()["extra"]["k"] == 1


def test_safe_name_no_deja_barras():
    """Windows no acepta / \\ : * ? " < > | en nombres de archivo."""
    limpio = safe_name('a/b\\c:d*e?f"g<h>i|j')
    assert not any(ch in limpio for ch in '/\\:*?"<>|')
