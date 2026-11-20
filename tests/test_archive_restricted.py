"""Internet Archive: archivos que el servidor no deja leer (403).

OFFLINE: el metadata del item es un httpx.MockTransport y la lectura de tags
(`identify_with_item`) es un doble.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

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


def test_si_todos_los_archivos_dan_403_se_dice_por_que(monkeypatch):
    error = "Client error '403 Forbidden' for url 'https://ia000.us.archive.org/x'"
    with pytest.raises(LookupError, match="no deja bajar"):
        _resolver(monkeypatch, {"uno.mp3": {"_error": error}, "dos.mp3": {"_error": error}})


def test_se_elige_un_archivo_legible_antes_que_uno_prohibido(monkeypatch):
    t = _resolver(monkeypatch, {
        "uno.mp3": {"_error": "Client error '403 Forbidden'"},
        "dos.mp3": {"title": "Otra", "_source": "tags"},
    })
    assert t.audio_url.endswith("/dos.mp3")


def test_un_error_pasajero_no_bloquea_la_descarga(monkeypatch):
    # Un timeout al leer las etiquetas no dice nada del archivo: se sigue.
    t = _resolver(monkeypatch, {
        "uno.mp3": {"_error": "ReadTimeout"},
        "dos.mp3": {"_error": "ReadTimeout"},
    })
    assert t.audio_url
