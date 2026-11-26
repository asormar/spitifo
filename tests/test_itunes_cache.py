"""Cache acotada de iTunes: una sola red por id, con TTL y desalojo.

Todo OFFLINE: un `httpx.MockTransport` cuenta las peticiones, asi que ningun
test pega a iTunes (ni a archive.org).
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

from backend.app import sources as s

COLECCION = {
    "wrapperType": "collection", "collectionId": 999, "artistId": 777,
    "collectionName": "Meteora", "artistName": "Linkin Park",
    "releaseDate": "2003-03-25T07:00:00Z", "trackCount": 12,
    "artworkUrl100": "http://x/100x100bb.jpg",
    "collectionExplicitness": "notExplicit",
}
CANCION = {
    "wrapperType": "track", "kind": "song", "trackId": 1,
    "trackName": "Uno", "artistName": "Linkin Park",
    "collectionId": 999, "collectionName": "Meteora",
    "trackTimeMillis": 200000,
}


def _transport(results, pedidos=None):
    def handler(request):
        if pedidos is not None:
            pedidos.append(request.url.params.get("id"))
        return httpx.Response(200, json={"results": results})

    return httpx.MockTransport(handler)


def _fuente(transport):
    fuente = s.ITunesSource()
    fuente._client = httpx.AsyncClient(transport=transport)
    return fuente


def _cerrar(fuente):
    asyncio.run(fuente.aclose())


def _reloj(monkeypatch, ahora):
    class Reloj:
        @staticmethod
        def time():
            return ahora[0]

    monkeypatch.setattr(s, "time", Reloj)


def test_dos_lookups_iguales_hacen_una_sola_peticion():
    pedidos: list[str] = []
    fuente = _fuente(_transport([COLECCION, CANCION], pedidos))

    async def correr():
        a = await fuente.lookup("999")
        b = await fuente.lookup("999")
        return a, b

    a, b = asyncio.run(correr())
    _cerrar(fuente)
    assert pedidos == ["999"], "la segunda lookup sale de la cache"
    assert a == b


def test_lookup_track_dos_pedidos_iguales_hacen_una_sola_peticion():
    """Finding (search-latency): `lookup_track` bypaseaba la cache de iTunes;
    una fila lazy sin `_TRACK_RAW_CACHE` (expiro o reinicio) pagaba un lookup
    por pista aunque el mismo id ya se hubiera pedido antes."""
    pedidos: list[str] = []
    fuente = _fuente(_transport([CANCION], pedidos))

    async def correr():
        a = await fuente.lookup_track("1")
        b = await fuente.lookup_track("1")
        return a, b

    a, b = asyncio.run(correr())
    _cerrar(fuente)
    assert pedidos == ["1"], "la segunda lookup_track sale de la cache"
    assert a == b


def test_album_detail_y_album_match_comparten_la_lookup(cliente, monkeypatch):
    """Ambas rutas pasan por `_album_lookup`: una sola ida a la red."""
    import backend.app.main as main
    from backend.app.sources import BY_NAME

    monkeypatch.setattr(main, "_ALBUM_MATCH_CACHE", {})
    monkeypatch.delenv("YTDLP_ENABLED", raising=False)
    pedidos: list[str] = []
    itunes = BY_NAME["itunes"]
    anterior = itunes._client
    itunes._client = httpx.AsyncClient(
        transport=_transport([COLECCION, CANCION], pedidos))
    try:
        d = cliente.get("/api/album/999")
        m = cliente.get("/api/album/999/match")
    finally:
        itunes._client = anterior
    assert d.status_code == 200
    assert m.status_code == 200
    assert pedidos == ["999"], "detail y match no repiten la peticion"


def test_despues_del_ttl_vuelve_a_buscar(monkeypatch):
    """TTL de 1800s (media hora, lo que dura una sesion de escucha)."""
    ahora = [1000.0]
    _reloj(monkeypatch, ahora)
    pedidos: list[str] = []
    fuente = _fuente(_transport([COLECCION, CANCION], pedidos))

    async def correr():
        await fuente.lookup("999")
        ahora[0] += 1000.0
        await fuente.lookup("999")  # dentro de los 1800s
        ahora[0] += 801.0           # 1801s: vencio
        await fuente.lookup("999")

    asyncio.run(correr())
    _cerrar(fuente)
    assert pedidos == ["999", "999"]


def test_el_tope_desaloja_el_mas_viejo():
    pedidos: list[str] = []

    def handler(request):
        pedidos.append(request.url.params.get("id"))
        aid = int(request.url.params["id"])
        return httpx.Response(200, json={"results": [
            {**COLECCION, "collectionId": aid},
            {**CANCION, "trackId": aid},
        ]})

    fuente = _fuente(httpx.MockTransport(handler))
    tope = s.ITUNES_CACHE_MAX

    async def correr():
        for i in range(tope):
            await fuente.lookup(str(i))
        await fuente.lookup(str(tope))  # una mas: sale el id 0
        await fuente.lookup("0")        # el desalojado vuelve a la red

    asyncio.run(correr())
    _cerrar(fuente)
    assert len(s._ITUNES_CACHE) == tope, "la cache nunca crece del tope"
    assert pedidos.count("0") == 2


def test_no_se_cachea_un_error(monkeypatch):
    intentos: list[int] = []

    def handler(request):
        intentos.append(1)
        if len(intentos) == 1:
            return httpx.Response(503)
        return httpx.Response(200, json={"results": [COLECCION, CANCION]})

    fuente = _fuente(httpx.MockTransport(handler))

    async def correr():
        with pytest.raises(httpx.HTTPStatusError):
            await fuente.lookup("999")
        return await fuente.lookup("999")

    col, canciones = asyncio.run(correr())
    _cerrar(fuente)
    assert len(intentos) == 2, "el fallo no quedo guardado"
    assert col == COLECCION and canciones == [CANCION]


def test_el_llamador_no_puede_mutar_la_cache():
    fuente = _fuente(_transport([COLECCION, CANCION]))

    async def correr():
        col, _ = await fuente.lookup("999")
        col["collectionName"] = "CAMBIADO"
        col2, _ = await fuente.lookup("999")
        return col2

    col2 = asyncio.run(correr())
    _cerrar(fuente)
    assert col2["collectionName"] == "Meteora", "la cache devuelve copias"
