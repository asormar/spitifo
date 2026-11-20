"""Internet Archive: archivos que el servidor no deja leer (403).

OFFLINE: el metadata del item es un httpx.MockTransport y la lectura de tags
(`identify_with_item`) es un doble.
"""
from __future__ import annotations

import asyncio

import httpx
from backend.app import identify
from backend.app.models import Track
from backend.app.sources import InternetArchiveSource

META = {
    "server": "ia000.us.archive.org",
    "dir": "/1/items/demo",
    "metadata": {"title": "Demo"},
    "files": [
        {"name": "uno.mp3", "size": "1000"},
        {"name": "dos.mp3", "size": "900"},
    ],
}


def _fuente():
    def responder(request):
        return httpx.Response(200, json=META)

    src = InternetArchiveSource()
    src._client = httpx.AsyncClient(transport=httpx.MockTransport(responder))
    return src


def _resolver(monkeypatch, tags_por_archivo):
    async def leer(url, fname, meta=None):
        return tags_por_archivo[fname]

    monkeypatch.setattr(identify, "identify_with_item", leer)
    track = Track(source="archive", source_id="demo", title="Uno", artist="")
    return asyncio.run(_fuente().resolve(track, query="uno"))


def test_si_todos_los_archivos_dan_403_queda_marcado_ilegible(monkeypatch):
    error = "Client error '403 Forbidden' for url 'https://ia000.us.archive.org/x'"
    t = _resolver(monkeypatch, {"uno.mp3": {"_error": error}, "dos.mp3": {"_error": error}})
    assert t.extra["match"] == "unknown"
    assert t.extra["unreadable"] is True


def test_se_elige_un_archivo_legible_antes_que_uno_prohibido(monkeypatch):
    t = _resolver(monkeypatch, {
        "uno.mp3": {"_error": "Client error '403 Forbidden'"},
        "dos.mp3": {"title": "Otra", "_source": "tags"},
    })
    assert t.audio_url.endswith("/dos.mp3")


def test_un_archivo_legible_no_queda_marcado(monkeypatch):
    t = _resolver(monkeypatch, {
        "uno.mp3": {"title": "Uno", "_source": "tags"},
        "dos.mp3": {"title": "Dos", "_source": "tags"},
    })
    assert "unreadable" not in t.extra
