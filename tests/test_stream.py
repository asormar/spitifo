"""Streaming: resolucion y proxy por rangos, TODO OFFLINE.

`yt_dlp` nunca se importa de verdad: se cambia el contextmanager del pool y el
`probe_info`. El upstream es un `httpx.MockTransport`, asi que ningun test toca
YouTube ni googlevideo.
"""
from __future__ import annotations

import asyncio
import re
import time
from contextlib import contextmanager

import httpx
import pytest
from starlette.testclient import TestClient

from backend.app import stream, ytdlp_source
from backend.app.main import create_app

URL = "https://www.youtube.com/watch?v=abcdefghijk"
VID = "abcdefghijk"
TOTAL = 2 * 1024 * 1024 + 1234
PAYLOAD = bytes((i % 251) for i in range(TOTAL))


def format_info(url=None):
    return {
        "url": url or f"https://googlevideo.test/audio.webm?expire={int(time.time()) + 3600}",
        "http_headers": {"User-Agent": "probe"},
        "ext": "webm",
        "filesize": TOTAL,
        "duration": 180,
    }


@pytest.fixture(autouse=True)
def limpio(monkeypatch):
    stream.clear()
    # El warm del lifespan no debe pegar a la red en los tests.
    async def no_op():
        return None

    monkeypatch.setattr(stream, "warm_visitor", no_op)
    yield
    stream.clear()


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("YTDLP_ENABLED", "1")
    with TestClient(create_app()) as c:
        yield c


def fake_pool(monkeypatch, result=None, error=None, calls=None):
    """Sustituye el pool por un YoutubeDL que devuelve `result` o levanta `error`."""
    calls = calls if calls is not None else []

    @contextmanager
    def pooled(visitor):
        class Ydl:
            def extract_info(self, url, download=False):
                calls.append((visitor, url))
                if error is not None:
                    raise error
                return result if isinstance(result, dict) else result()

        yield Ydl()

    monkeypatch.setattr(stream, "_pooled", pooled)

    async def visitor():
        return "visitor-de-prueba"

    monkeypatch.setattr(stream, "ensure_visitor", visitor)
    return calls


# ------------------------------------------------------------------ resolucion
def test_camino_rapido(monkeypatch):
    calls = fake_pool(monkeypatch, result=format_info())
    full = []

    async def probe(url, format=None):
        full.append(url)
        return format_info()

    monkeypatch.setattr(ytdlp_source, "probe_info", probe)
    info = asyncio.run(stream.resolve(URL))
    assert info.path == "fast"
    assert info.mime == "audio/webm"
    assert info.filesize == TOTAL
    assert info.duration == 180
    assert len(calls) == 1 and calls[0][0] == "visitor-de-prueba"
    assert full == []


def test_fallo_rapido_cae_al_completo_e_invalida_visitor(monkeypatch):
    fake_pool(monkeypatch, error=RuntimeError("muro"))
    invalidados = []
    real = stream.invalidate

    def spy():
        invalidados.append(1)
        real()

    monkeypatch.setattr(stream, "invalidate", spy)
    full = []

    async def probe(url, format=None):
        full.append((url, format))
        return format_info("https://googlevideo.test/otro.webm?expire=9999999999")

    monkeypatch.setattr(ytdlp_source, "probe_info", probe)
    info = asyncio.run(stream.resolve(URL))
    assert info.path == "full"
    assert info.expires_at == 9999999999
    assert full == [(URL, "bestaudio")]
    assert invalidados, "un fallo rapido tiene que descartar el visitor_data"


def test_cache_evita_segunda_extraccion(monkeypatch):
    calls = fake_pool(monkeypatch, result=format_info())
    uno = asyncio.run(stream.resolve(URL))
    dos = asyncio.run(stream.resolve(URL))
    assert uno is dos
    assert len(calls) == 1


def test_resoluciones_concurrentes_se_comparten(monkeypatch):
    calls = fake_pool(monkeypatch, result=format_info())

    async def tres():
        return await asyncio.gather(*[stream.resolve(URL) for _ in range(3)])

    salidas = asyncio.run(tres())
    assert salidas[0] is salidas[1] is salidas[2]
    assert len(calls) == 1


# ----------------------------------------------------------------------- rutas
def transporte(ranges, *, fallar_url=None):
    """Upstream falso: sirve exactamente el rango pedido, en trozos de 1 MiB."""

    def handler(request):
        ranges.append(request.headers.get("range"))
        if fallar_url and fallar_url in str(request.url):
            return httpx.Response(403)
        m = re.match(r"bytes=(\d+)-(\d+)$", request.headers.get("range", ""))
        if not m:
            return httpx.Response(400)
        a, b = int(m.group(1)), int(m.group(2))
        b = min(b, TOTAL - 1)
        body = PAYLOAD[a:b + 1]
        return httpx.Response(206, content=body,
                              headers={"Content-Range": f"bytes {a}-{b}/{TOTAL}"})

    return httpx.MockTransport(handler)


def sembrar(url=URL, filesize=TOTAL):
    info = stream.StreamInfo(
        url=url, headers={}, ext="webm", mime="audio/webm",
        filesize=filesize, duration=180, expires_at=time.time() + 3600, path="fast",
    )
    stream._cache[stream.video_id(url)] = info


def instalar_cliente(monkeypatch, transport):
    monkeypatch.setattr(stream, "make_client",
                        lambda: httpx.AsyncClient(transport=transport))


@pytest.mark.parametrize("rango,status,esperado", [
    ("bytes=0-", 206, PAYLOAD),
    ("bytes=1000-2000", 206, PAYLOAD[1000:2001]),
    (None, 200, PAYLOAD),
], ids=["desde-cero", "cerrado", "sin-rango"])
def test_proxy_por_rangos(api, monkeypatch, rango, status, esperado):
    sembrar()
    ranges = []
    instalar_cliente(monkeypatch, transporte(ranges))
    headers = {"Range": rango} if rango else {}
    r = api.get("/api/stream", params={"url": URL}, headers=headers)
    assert r.status_code == status
    assert r.content == esperado
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-type"].startswith("audio/webm")
    assert r.headers["content-length"] == str(len(esperado))
    if rango:
        a, b = rango[6:].split("-")
        fin = int(b) if b else TOTAL - 1
        assert r.headers["content-range"] == f"bytes {a}-{fin}/{TOTAL}"
    assert ranges, "tiene que pedir rangos al upstream"
    for value in ranges:
        a, b = map(int, value[6:].split("-"))
        assert b - a + 1 <= stream.MAX_CHUNK


def test_403_antes_de_enviar_bytes_resuelve_una_vez_mas(api, monkeypatch):
    primera = "https://googlevideo.test/viejo.webm?expire=1"
    segunda = "https://googlevideo.test/nuevo.webm?expire=2"
    ranges = []
    instalar_cliente(monkeypatch, transporte(ranges, fallar_url=primera))
    resueltas = []

    async def resolve(url, force=False):
        resueltas.append((url, force))
        url_up = segunda if len(resueltas) > 1 else primera
        return stream.StreamInfo(
            url=url_up, headers={}, ext="webm", mime="audio/webm",
            filesize=TOTAL, duration=180, expires_at=time.time() + 3600,
            path="fast",
        )

    monkeypatch.setattr(stream, "resolve", resolve)
    r = api.get("/api/stream", params={"url": URL}, headers={"Range": "bytes=0-100"})
    assert r.status_code == 206
    assert r.content == PAYLOAD[:101]
    assert len(resueltas) == 2 and resueltas[1][1] is True
    assert len(ranges) == 2, "el primer 403 no debe contar como trozo servido"


def test_url_invalida_da_400(api):
    r = api.get("/api/stream", params={"url": "https://example.com/cancion"})
    assert r.status_code == 400


def test_prepare_responde_202(api, monkeypatch):
    resueltas = []

    async def resolve(url, force=False):
        resueltas.append(url)

    monkeypatch.setattr(stream, "resolve", resolve)
    r = api.post("/api/stream/prepare", json={"url": URL})
    assert r.status_code == 202
    assert r.json()["preparing"] is True
    # La tarea corre en background: puede acabar antes o despues del respuesta.
    assert resueltas == [] or resueltas == [URL]


def test_sin_ytdlp_da_204(monkeypatch):
    monkeypatch.setenv("YTDLP_ENABLED", "0")
    with TestClient(create_app()) as c:
        assert c.get("/api/stream", params={"url": URL}).status_code == 204
        assert c.post("/api/stream/prepare", json={"url": URL}).status_code == 204
