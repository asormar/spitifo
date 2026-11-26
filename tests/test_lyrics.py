"""Letra sincronizada via LRCLIB: GET /api/lyrics y el modulo backend.app.lyrics.

Todo OFFLINE: un `httpx.MockTransport` inyectado via `lyrics._make_client`
cuenta las peticiones, asi que ningun test pega a lrclib.net.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

from backend.app import lyrics


LRC_MULTI = (
    "[ar:Radiohead]\n"
    "[ti:Creep]\n"
    "[offset:0]\n"
    "\n"
    "[00:12.00]I'm a creep\n"
    "[00:15.340][00:45.00]I'm a weirdo\n"
    "[00:20]\n"
)

TRACK_HIT = {
    "id": 1, "trackName": "Creep", "artistName": "Radiohead",
    "albumName": "Pablo Honey", "duration": 238,
    "instrumental": False,
    "plainLyrics": "I'm a creep\nI'm a weirdo",
    "syncedLyrics": LRC_MULTI,
}

TRACK_INSTRUMENTAL = {
    "id": 2, "trackName": "Interstellar (Main Theme)",
    "artistName": "Hans Zimmer", "albumName": "Interstellar",
    "duration": 300, "instrumental": True,
    "plainLyrics": None, "syncedLyrics": None,
}


def _client_factory(transport):
    def _make():
        return httpx.AsyncClient(transport=transport, headers=lyrics._HEADERS)
    return _make


def _install(monkeypatch, handler):
    monkeypatch.setattr(lyrics, "_make_client", _client_factory(httpx.MockTransport(handler)))


# --------------------------------------------------------------- parse_lrc
def test_parse_lrc_multi_timestamp_metadata_y_lineas_vacias():
    filas = lyrics.parse_lrc(LRC_MULTI)
    assert filas == [
        {"t": 12.0, "line": "I'm a creep"},
        {"t": 15.34, "line": "I'm a weirdo"},
        {"t": 20.0, "line": ""},
        {"t": 45.0, "line": "I'm a weirdo"},
    ]


def test_parse_lrc_vacio_o_none():
    assert lyrics.parse_lrc(None) == []
    assert lyrics.parse_lrc("") == []
    assert lyrics.parse_lrc("[ar:Radiohead]\n[ti:Creep]\n") == []


# ------------------------------------------------------------- lookup exacto
def test_lookup_exacto_hit(monkeypatch):
    pedidos: list[str] = []

    def handler(request):
        pedidos.append(request.url.path)
        assert request.url.path == "/api/get"
        assert request.url.params["track_name"] == "Creep"
        assert request.url.params["artist_name"] == "Radiohead"
        assert request.url.params["album_name"] == "Pablo Honey"
        assert request.url.params["duration"] == "238"
        assert "spitifo" in request.headers["user-agent"]
        return httpx.Response(200, json=TRACK_HIT)

    _install(monkeypatch, handler)

    r = asyncio.run(lyrics.get_lyrics(
        title="Creep", artist="Radiohead", album="Pablo Honey", duration=238))

    assert pedidos == ["/api/get"]
    assert r["source"] == "lrclib"
    assert r["instrumental"] is False
    assert r["plain"] == "I'm a creep\nI'm a weirdo"
    assert r["synced"][0] == {"t": 12.0, "line": "I'm a creep"}
    assert "error" not in r


# ------------------------------------------------------- busqueda de respaldo
def test_busqueda_de_respaldo_elige_por_duracion(monkeypatch):
    """El exacto (404) falla; la busqueda trae varios y se elige el de
    duracion mas cercana (dentro de +/-3s)."""
    rutas: list[str] = []
    otro = {**TRACK_HIT, "trackName": "Creep", "artistName": "Radiohead",
           "duration": 9999}

    def handler(request):
        rutas.append(request.url.path)
        if request.url.path == "/api/get":
            return httpx.Response(404, json={"statusCode": 404,
                                              "error": "TrackNotFound"})
        assert request.url.path == "/api/search"
        assert request.url.params["track_name"] == "Creep"
        assert request.url.params["artist_name"] == "Radiohead"
        return httpx.Response(200, json=[otro, TRACK_HIT])

    _install(monkeypatch, handler)

    r = asyncio.run(lyrics.get_lyrics(
        title="Creep", artist="Radiohead", album="Pablo Honey", duration=240))

    assert rutas == ["/api/get", "/api/search"]
    assert r["source"] == "lrclib"
    assert r["plain"] == "I'm a creep\nI'm a weirdo"


def test_busqueda_sin_album_ni_duracion_salta_el_exacto(monkeypatch):
    rutas: list[str] = []

    def handler(request):
        rutas.append(request.url.path)
        return httpx.Response(200, json=[TRACK_HIT])

    _install(monkeypatch, handler)

    r = asyncio.run(lyrics.get_lyrics(title="Creep", artist="Radiohead"))

    assert rutas == ["/api/search"]
    assert r["source"] == "lrclib"


def test_busqueda_descarta_todo_fuera_de_la_tolerancia_de_duracion(monkeypatch):
    lejano = {**TRACK_HIT, "duration": 100}

    def handler(request):
        if request.url.path == "/api/get":
            return httpx.Response(404, json={})
        return httpx.Response(200, json=[lejano])

    _install(monkeypatch, handler)

    r = asyncio.run(lyrics.get_lyrics(
        title="Creep", artist="Radiohead", album="Pablo Honey", duration=238))

    assert r == {"synced": None, "plain": None, "instrumental": False,
                 "source": None}


# ----------------------------------------------------------------- instrumental
def test_instrumental_sin_letra(monkeypatch):
    def handler(request):
        return httpx.Response(200, json=TRACK_INSTRUMENTAL)

    _install(monkeypatch, handler)

    r = asyncio.run(lyrics.get_lyrics(
        title="Interstellar (Main Theme)", artist="Hans Zimmer",
        album="Interstellar", duration=300))

    assert r["source"] == "lrclib"
    assert r["instrumental"] is True
    assert r["synced"] is None
    assert r["plain"] is None


# ------------------------------------------------------------------------ cache
def test_segunda_llamada_no_repite_la_peticion(monkeypatch):
    pedidos: list[str] = []

    def handler(request):
        pedidos.append(request.url.path)
        return httpx.Response(200, json=TRACK_HIT)

    _install(monkeypatch, handler)

    async def correr():
        a = await lyrics.get_lyrics(title="Creep", artist="Radiohead",
                                    album="Pablo Honey", duration=238)
        b = await lyrics.get_lyrics(title="Creep", artist="Radiohead",
                                    album="Pablo Honey", duration=238)
        return a, b

    a, b = asyncio.run(correr())
    assert pedidos == ["/api/get"]
    assert a == b


def test_cache_guarda_tambien_los_fallos(monkeypatch):
    pedidos: list[str] = []

    def handler(request):
        pedidos.append(request.url.path)
        if request.url.path == "/api/get":
            return httpx.Response(404, json={})
        return httpx.Response(200, json=[])

    _install(monkeypatch, handler)

    async def correr():
        await lyrics.get_lyrics(title="Nada", artist="Nadie",
                                album="X", duration=100)
        return await lyrics.get_lyrics(title="Nada", artist="Nadie",
                                       album="X", duration=100)

    r = asyncio.run(correr())
    assert pedidos == ["/api/get", "/api/search"]
    assert r["source"] is None


def test_el_tope_desaloja_el_mas_viejo(monkeypatch):
    def handler(request):
        return httpx.Response(200, json=[TRACK_HIT])

    _install(monkeypatch, handler)
    tope = lyrics._CACHE_MAX

    async def correr():
        for i in range(tope):
            await lyrics.get_lyrics(title=f"T{i}", artist="A", duration=100)
        await lyrics.get_lyrics(title=f"T{tope}", artist="A", duration=100)

    asyncio.run(correr())
    assert len(lyrics._CACHE) == tope


# --------------------------------------------------------- pedido compartido
class _ClienteNulo:
    """Doble de `httpx.AsyncClient` como context manager: `_lookup_uno` va
    reemplazado, asi que ningun test necesita un cliente real aca."""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def test_pedidos_concurrentes_de_la_misma_cancion_comparten_la_red(monkeypatch):
    """Dos pedidos a la vez de la misma cancion: el segundo espera el lock y
    sale de la cache que dejo el primero, sin repetir el lookup.

    `_lookup_uno` (no la red) lleva un `sleep` real para forzar que el
    scheduler alterne entre ambas corrutinas, igual que
    `test_top_concurrente_un_solo_llamado` en test_artist_top.py.
    """
    llamadas: list[str] = []

    async def _lookup_falso(client, title, artist, album, duration):
        llamadas.append(title)
        await asyncio.sleep(0.01)
        return TRACK_HIT

    monkeypatch.setattr(lyrics, "_make_client", _ClienteNulo)
    monkeypatch.setattr(lyrics, "_lookup_uno", _lookup_falso)

    async def correr():
        return await asyncio.gather(
            lyrics.get_lyrics(title="Creep", artist="Radiohead",
                              album="Pablo Honey", duration=238),
            lyrics.get_lyrics(title="Creep", artist="Radiohead",
                              album="Pablo Honey", duration=238),
        )

    a, b = asyncio.run(correr())
    assert llamadas == ["Creep"], "la segunda espera el lock y sale de la cache"
    assert a == b


# -------------------------------------------------------------- fallo de red
def test_fallo_de_red_da_nulls_con_error_unavailable(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("sin red", request=request)

    _install(monkeypatch, handler)

    r = asyncio.run(lyrics.get_lyrics(
        title="Creep", artist="Radiohead", album="Pablo Honey", duration=238))

    assert r == {"synced": None, "plain": None, "instrumental": False,
                 "source": None, "error": "unavailable"}


def test_fallo_de_red_no_se_cachea(monkeypatch):
    pedidos: list[str] = []

    def handler(request):
        pedidos.append(1)
        raise httpx.ConnectError("sin red", request=request)

    _install(monkeypatch, handler)

    async def correr():
        await lyrics.get_lyrics(title="Creep", artist="Radiohead", duration=238)
        await lyrics.get_lyrics(title="Creep", artist="Radiohead", duration=238)

    asyncio.run(correr())
    assert len(pedidos) == 2, "un fallo de red no queda cacheado: reintenta"


# ------------------------------------------------------------------- aliases
def test_alias_en_japones_se_prueba_despues_del_original(monkeypatch):
    consultas = []

    def handler(request):
        if request.url.path == "/api/get":
            return httpx.Response(404, json={})
        consultas.append(request.url.params["track_name"])
        if request.url.params["track_name"] == "Mesmerizer":
            return httpx.Response(200, json=[])
        return httpx.Response(200, json=[{
            **TRACK_HIT, "trackName": "めざめ", "artistName": "重音テト",
            "duration": 200,
        }])

    _install(monkeypatch, handler)

    r = asyncio.run(lyrics.get_lyrics(
        title="Mesmerizer", artist="Kasane Teto", duration=200,
        alt_titles=["めざめ"], alt_artists=["重音テト"]))

    assert consultas == ["Mesmerizer", "めざめ"]
    assert r["source"] == "lrclib"


def test_sin_alias_queda_en_null(monkeypatch):
    def handler(request):
        if request.url.path == "/api/get":
            return httpx.Response(404, json={})
        return httpx.Response(200, json=[])

    _install(monkeypatch, handler)

    r = asyncio.run(lyrics.get_lyrics(
        title="Mesmerizer", artist="Kasane Teto", duration=200))

    assert r["source"] is None


# ----------------------------------------------------------------------- ruta
def test_ruta_hit(cliente, monkeypatch):
    def handler(request):
        return httpx.Response(200, json=TRACK_HIT)

    _install(monkeypatch, handler)

    r = cliente.get("/api/lyrics", params={
        "title": "Creep", "artist": "Radiohead",
        "album": "Pablo Honey", "duration": 238,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "lrclib"
    assert body["synced"][0]["line"] == "I'm a creep"


def test_ruta_miss_es_200_con_nulls(cliente, monkeypatch):
    def handler(request):
        if request.url.path == "/api/get":
            return httpx.Response(404, json={})
        return httpx.Response(200, json=[])

    _install(monkeypatch, handler)

    r = cliente.get("/api/lyrics", params={"title": "Nada", "artist": "Nadie"})
    assert r.status_code == 200
    assert r.json() == {"synced": None, "plain": None,
                        "instrumental": False, "source": None}


def test_ruta_fallo_de_red_es_200_con_error(cliente, monkeypatch):
    def handler(request):
        raise httpx.ConnectError("sin red", request=request)

    _install(monkeypatch, handler)

    r = cliente.get("/api/lyrics", params={"title": "Creep", "artist": "Radiohead"})
    assert r.status_code == 200
    assert r.json()["error"] == "unavailable"


def test_ruta_con_alias_repetidos(cliente, monkeypatch):
    consultas = []

    def handler(request):
        if request.url.path == "/api/get":
            return httpx.Response(404, json={})
        consultas.append(request.url.params["track_name"])
        if request.url.params["track_name"] == "Mesmerizer":
            return httpx.Response(200, json=[])
        return httpx.Response(200, json=[{
            **TRACK_HIT, "trackName": "めざめ", "artistName": "重音テト",
        }])

    _install(monkeypatch, handler)

    r = cliente.get("/api/lyrics", params=[
        ("title", "Mesmerizer"), ("artist", "Kasane Teto"),
        ("alt_title", "めざめ"), ("alt_artist", "重音テト"),
    ])
    assert r.status_code == 200
    assert consultas == ["Mesmerizer", "めざめ"]
    assert r.json()["source"] == "lrclib"


@pytest.mark.parametrize("params,campo", [
    ({"artist": "Radiohead"}, "title"),
    ({"title": "Creep"}, "artist"),
])
def test_ruta_valida_campos_obligatorios(cliente, params, campo):
    r = cliente.get("/api/lyrics", params=params)
    assert r.status_code == 422
    assert r.json()["detail"][0]["loc"] == ["query", campo]


def test_ruta_valida_largo_maximo(cliente):
    r = cliente.get("/api/lyrics", params={
        "title": "x" * 201, "artist": "Radiohead"})
    assert r.status_code == 422


def test_ruta_valida_duracion_fuera_de_rango(cliente):
    r = cliente.get("/api/lyrics", params={
        "title": "Creep", "artist": "Radiohead", "duration": -1})
    assert r.status_code == 422


def test_ruta_valida_duracion_no_numerica(cliente):
    r = cliente.get("/api/lyrics", params={
        "title": "Creep", "artist": "Radiohead", "duration": "abc"})
    assert r.status_code == 422
