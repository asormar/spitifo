"""Portadas de las descargas de audio: URLs permitidas, nombres y `library_scan`.

Todo OFFLINE: nada pega a iTunes. Las bajadas de las portadas se prueban en
test_download_fileinfo.py con un `_get` falso.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

from backend.app import covers
from backend.app.covers import fetch_itunes_covers, itunes_cover_urls
from backend.app.downloader import library_scan, thumb_small_sidecar
from backend.app.main import create_app
from backend.app.storage import set_storage
from backend.app.storage.local import LocalStorage

BASE = ("https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/ab/cd/ef/"
        "source/")


# ------------------------------------------------------------ itunes_cover_urls
def test_deriva_las_urls_de_200_y_100_px():
    assert itunes_cover_urls(BASE + "300x300bb.jpg") == (
        BASE + "200x200bb.jpg", BASE + "100x100bb.jpg")


def test_acepta_el_host_pelado_y_sus_subdominios():
    assert itunes_cover_urls("https://mzstatic.com/a/600x600bb.jpg")
    assert itunes_cover_urls("https://a1.mzstatic.com/a/600x600bb.jpg")


@pytest.mark.parametrize("url", [
    None, "", 5,
    "http://is1-ssl.mzstatic.com/a/300x300bb.jpg",
    "https://localhost/a/300x300bb.jpg",
    "https://127.0.0.1/a/300x300bb.jpg",
    "https://evil.com/mzstatic.com/a/300x300bb.jpg",
    "https://mzstatic.com.evil.com/a/300x300bb.jpg",
    "https://evilmzstatic.com/a/300x300bb.jpg",
    "https://user:pw@is1-ssl.mzstatic.com/a/300x300bb.jpg",
    "https://is1-ssl.mzstatic.com:8443/a/300x300bb.jpg",
    "https://is1-ssl.mzstatic.com/a/300x300bb.jpg?x=1",
    "https://is1-ssl.mzstatic.com/a/cover.jpg",
    "https://is1-ssl.mzstatic.com/a/300x300bb.png",
])
def test_rechaza_lo_que_no_es_una_portada_de_itunes(url):
    assert itunes_cover_urls(url) is None


# ----------------------------------------------------------- nombres de sidecars
@pytest.mark.parametrize("key,esperado", [
    ("Artista/Artista - Tema.mp3", "Artista/Artista - Tema.s.jpg"),
    ("A/Tema (live).m4a", "A/Tema (live).s.jpg"),
    ("A/B.v1.2.ogg", "A/B.v1.2.s.jpg"),
    ("sin-carpeta.flac", "sin-carpeta.s.jpg"),
    ("A/sin-extension", "A/sin-extension.s.jpg"),
])
def test_el_sidecar_chico_es_stem_s_jpg(key, esperado):
    assert thumb_small_sidecar(key) == esperado


# ------------------------------------------------------------------ library_scan
def _poner(root: Path, *claves: str) -> None:
    for clave in claves:
        ruta = root / clave
        ruta.parent.mkdir(parents=True, exist_ok=True)
        ruta.write_bytes(b"\x00" * 16)


def test_thumb_s_solo_si_existe_la_chica_y_los_jpg_no_son_temas(
        tmp_path, storage_temporal):
    storage_temporal(tmp_path)
    _poner(tmp_path, "A/uno.mp3", "A/uno.jpg", "A/uno.s.jpg",
           "A/dos.mp3", "A/dos.jpg", "A/tres.mp3")

    filas = {f["filename"]: f for f in library_scan()}

    assert set(filas) == {"uno.mp3", "dos.mp3", "tres.mp3"}
    assert filas["uno.mp3"]["thumb_s"] is True
    assert filas["uno.mp3"]["thumb_key"] == "A/uno.jpg"
    assert "thumb_s" not in filas["dos.mp3"]
    assert filas["dos.mp3"]["thumb_key"] == "A/dos.jpg"
    assert "thumb_s" not in filas["tres.mp3"]
    assert filas["tres.mp3"]["thumb_key"] is None


def test_una_chica_huerfana_no_da_portada(tmp_path, storage_temporal):
    storage_temporal(tmp_path)
    _poner(tmp_path, "A/uno.mp3", "A/uno.s.jpg")

    (fila,) = library_scan()
    assert fila["thumb_key"] is None and "thumb_s" not in fila


# ----------------------------------------------------------------- /api/audio
@pytest.fixture
def api(tmp_path):
    root = tmp_path / "lib"
    root.mkdir()
    set_storage(LocalStorage(root))
    try:
        with TestClient(create_app()) as client:
            yield client, root
    finally:
        set_storage(None)


def test_sirve_la_portada_chica_con_cache_de_una_semana_y_rangos(api):
    client, root = api
    datos = bytes(range(200))
    _poner(root, "A/uno.mp3")
    (root / "A" / "uno.s.jpg").write_bytes(datos)

    completa = client.get("/api/audio", params={"key": "A/uno.s.jpg"})
    assert completa.status_code == 200
    assert completa.headers["content-type"].startswith("image/jpeg")
    assert completa.headers["cache-control"] == "private, max-age=604800"
    assert completa.content == datos

    rango = client.get("/api/audio", params={"key": "A/uno.s.jpg", "v": "123"},
                       headers={"Range": "bytes=10-19"})
    assert rango.status_code == 206 and rango.content == datos[10:20]


# ------------------------------------------------------------ fetch_itunes_covers
def test_no_se_pide_nada_si_la_url_no_es_de_itunes(tmp_path, monkeypatch):
    async def no_debe_llamarse(client, url):
        raise AssertionError("no tendria que bajar nada")

    monkeypatch.setattr(covers, "_get", no_debe_llamarse)
    assert asyncio.run(fetch_itunes_covers("https://evil.com/300x300bb.jpg",
                                           tmp_path)) is None


def test_una_redireccion_fuera_de_la_lista_se_rechaza(tmp_path):
    """`_get` solo sigue saltos que siguen dentro de mzstatic.com."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "https://evil.com/x.jpg"})

    async def correr():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler),
                                     follow_redirects=False) as client:
            return await covers._get(client, BASE + "200x200bb.jpg")

    with pytest.raises(ValueError):
        asyncio.run(correr())


def test_una_respuesta_que_no_es_jpg_no_vale(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"<html>no es una imagen</html>")

    async def correr():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler),
                                     follow_redirects=False) as client:
            return await covers._get(client, BASE + "200x200bb.jpg")

    with pytest.raises(ValueError):
        asyncio.run(correr())
