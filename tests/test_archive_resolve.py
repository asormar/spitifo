"""`InternetArchiveSource.resolve`: el veredicto cuando no se pueden leer los tags.

Offline: la metadata del item sale de un `httpx.MockTransport` y la lectura de
tags (`identify.identify`) se reemplaza. Archive.org responde 403 a algunos
archivos de items restringidos; antes `resolve` devolvia la pista SIN `match` y
la UI no tenia veredicto que mostrar.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

import backend.app.identify as identify
from backend.app.models import Track
from backend.app.sources import InternetArchiveSource

METADATA = {
    "server": "ia800000.us.archive.org",
    "dir": "/1/items/item-de-prueba",
    "metadata": {"title": "Blues de prueba", "licenseurl": None},
    "files": [{"name": "blues.mp3", "size": "1000", "length": "180"}],
}


def _resolver(monkeypatch, lectura: dict) -> Track:
    async def identify_falso(url, fname):
        return dict(lectura)

    monkeypatch.setattr(identify, "identify", identify_falso)
    fuente = InternetArchiveSource()
    fuente._client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json=METADATA)))
    track = Track(source="archive", source_id="item-de-prueba",
                  title="Blues de prueba", artist="varios")

    async def correr():
        try:
            return await fuente.resolve(track, query="blues")
        finally:
            await fuente.aclose()

    return asyncio.run(correr())


def test_un_403_al_leer_los_tags_da_veredicto_unknown(monkeypatch):
    t = _resolver(monkeypatch, {"_error": "Client error '403 Forbidden'"})
    assert t.audio_url.endswith("/blues.mp3")
    assert t.extra["match"] == "unknown"
    assert "archive.org" in t.extra["match_label"]


@pytest.mark.parametrize("lectura,esperado", [
    ({"title": "Blues", "_source": "tags"}, "match"),
    ({"_source": "none"}, "match"),  # sin tags: se usa el titulo del item
])
def test_con_tags_o_titulo_del_item_hay_veredicto(monkeypatch, lectura, esperado):
    t = _resolver(monkeypatch, lectura)
    assert t.extra["match"] == esperado
