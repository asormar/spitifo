"""El match de album en stream (NDJSON): album, lotes y done.

Los dobles son los mismos que en test_albums.py: iTunes y yt-dlp no tocan la
red. Aca ademas las busquedas puntuales tardan distinto para ver que las pistas
se anuncian en cuanto se resuelve CADA una, no al final de todas.
"""
from __future__ import annotations

import asyncio
import contextlib
import json

import pytest


def _song(track_id, titulo):
    return {
        "wrapperType": "track", "kind": "song",
        "trackId": track_id, "collectionId": 999,
        "trackName": titulo, "artistName": "Linkin Park",
        "collectionName": "Meteora", "trackTimeMillis": 200_000,
        "artworkUrl100": "http://x/100x100bb.jpg",
        "releaseDate": "2003-03-25T07:00:00Z",
        "collectionExplicitness": "notExplicit",
        "trackNumber": track_id, "discNumber": 1,
        "trackCount": 4, "discCount": 1,
        "previewUrl": "http://p", "trackViewUrl": "http://t",
    }


def _video(clave, titulo):
    return {
        "video": {"id": f"v{clave}", "title": titulo, "uploader": "Linkin Park"},
        "score": 0.9, "why": "canal",
        "webpage_url": f"https://www.youtube.com/watch?v=v{clave}",
    }


def _instalar(cliente, monkeypatch, canciones, enriquecer, *, album="999"):
    """Deja iTunes, yt-dlp y la cache listos para una corrida de match."""
    import backend.app.main as main
    from backend.app.sources import ITunesSource

    async def _lookup(self, album_id):
        return None, list(canciones)

    class YtDlp:
        def available(self):
            return True

    monkeypatch.setattr(ITunesSource, "lookup", _lookup)
    monkeypatch.setitem(main.BY_NAME, "ytdlp", YtDlp())
    monkeypatch.setattr(main, "_ALBUM_MATCH_CACHE", {})
    monkeypatch.setattr("backend.app.matcher.enrich_with_ytdlp", enriquecer)
    return main


def _stream(cliente, url):
    with cliente.stream("GET", url) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("application/x-ndjson")
        return [json.loads(linea) for linea in r.iter_lines() if linea.strip()]


# ---------------------------------------------------------- orden y lotes
def test_stream_album_primero_done_ultimo_y_pistas_incrementales(cliente, monkeypatch):
    import backend.app.main as main

    canciones = [_song(i, f"P{i}") for i in range(1, 5)]
    retardos = {"1": 0.0, "2": 0.03, "3": 0.01, "4": 0.02}
    llamadas = []

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        clave = str(tracks[0]["trackId"])
        llamadas.append((len(tracks), clave, limit))
        if len(tracks) > 1:
            # La busqueda del album solo empareja la primera pista.
            return {str(t["trackId"]): (
                _video("1", "P1") if t is tracks[0] else
                {"video": None, "score": 0.0, "why": "sin-señal"}
            ) for t in tracks}
        await asyncio.sleep(retardos[clave])
        return {clave: _video(clave, f"P{clave}")}

    _instalar(cliente, monkeypatch, canciones, _enrich)
    eventos = _stream(cliente, "/api/album/999/match?stream=1")

    tipos = [e["type"] for e in eventos]
    assert tipos[0] == "album"
    assert tipos[-1] == "done"
    assert tipos.count("tracks") == 1 + 3  # album + 3 pistas sueltas
    assert eventos[0]["album"]["title"] == "Meteora"
    assert eventos[0]["ytdlp"] is True

    lotes = [e["tracks"] for e in eventos if e["type"] == "tracks"]
    assert [t["title"] for t in lotes[0]] == ["P1"]
    # Cada pista se anuncia cuando termina SU busqueda, no en orden de lista.
    sueltos = [t["title"] for lote in lotes[1:] for t in lote]
    assert sueltos == ["P3", "P4", "P2"]

    # Todas las lineas de tracks tienen la misma forma que la ruta JSON.
    for lote in lotes:
        for t in lote:
            assert t["source"] == "itunes"
            assert t["extra"]["has_full"] is True
            assert t["extra"]["webpage_url"].startswith("https://www.youtube.com/")

    done = eventos[-1]
    assert done["full"] == 4
    assert [t["title"] for t in done["tracks"]] == ["P1", "P2", "P3", "P4"]
    assert all(t["extra"]["has_full"] for t in done["tracks"])
    assert "album" not in done and "ytdlp" not in done

    # El limite de 3 se conserva en la busqueda por pista.
    assert llamadas[0][0] == 4 and llamadas[0][2] == 40
    puntuales = [c for c in llamadas if c[0] == 1]
    assert len(puntuales) == 3
    assert all(c[2] == main._ALBUM_TRACK_LIMIT for c in puntuales)


def test_stream_pista_sin_match_solo_aparece_en_done(cliente, monkeypatch):
    canciones = [_song(1, "P1"), _song(2, "P2")]

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        if len(tracks) > 1:
            return {}
        clave = str(tracks[0]["trackId"])
        await asyncio.sleep(0.01 if clave == "1" else 0.03)
        return {clave: _video(clave, f"P{clave}")} if clave == "1" else {}

    _instalar(cliente, monkeypatch, canciones, _enrich)
    eventos = _stream(cliente, "/api/album/999/match?stream=1")

    lotes = [e["tracks"] for e in eventos if e["type"] == "tracks"]
    # El lote de la busqueda fallida viene vacio: P2 no se anuncia.
    assert [t["title"] for lote in lotes for t in lote] == ["P1"]
    done = eventos[-1]
    assert done["full"] == 1
    por_titulo = {t["title"]: t for t in done["tracks"]}
    assert por_titulo["P1"]["extra"]["has_full"] is True
    assert por_titulo["P2"]["extra"]["has_full"] is False


# --------------------------------------------------------------- cache
def test_stream_cache_hit_emite_album_y_done_sin_buscar(cliente, monkeypatch):
    llamadas = []

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        llamadas.append(len(tracks))
        return {str(tracks[0]["trackId"]): _video(
            str(tracks[0]["trackId"]), tracks[0]["trackName"])}

    _instalar(cliente, monkeypatch, [_song(1, "P1")], _enrich)

    # La ruta JSON llena la cache, como hacia antes.
    json_payload = cliente.get("/api/album/999/match").json()
    assert llamadas
    antes = list(llamadas)

    eventos = _stream(cliente, "/api/album/999/match?stream=1")
    assert [e["type"] for e in eventos] == ["album", "done"]
    assert eventos[0]["album"] == json_payload["album"]
    assert eventos[0]["ytdlp"] == json_payload["ytdlp"]
    assert eventos[1]["full"] == json_payload["full"]
    assert eventos[1]["tracks"] == json_payload["tracks"]
    assert llamadas == antes  # no volvio a YouTube


def test_ruta_json_sigue_devolviendo_el_mismo_payload(cliente, monkeypatch):
    canciones = [_song(1, "P1"), _song(2, "P2")]

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        return {str(t["trackId"]): _video(str(t["trackId"]), t["trackName"])
                for t in tracks}

    _instalar(cliente, monkeypatch, canciones, _enrich)
    cuerpo = cliente.get("/api/album/999/match").json()
    assert set(cuerpo) == {"album", "tracks", "ytdlp", "full"}
    assert cuerpo["full"] == 2
    assert [t["title"] for t in cuerpo["tracks"]] == ["P1", "P2"]

    # El `done` del stream coincide con la respuesta JSON de ese mismo album.
    Done = _stream(cliente, "/api/album/999/match?stream=1")[-1]
    assert Done["full"] == cuerpo["full"]
    assert Done["tracks"] == cuerpo["tracks"]


# ----------------------------------------------------- cliente desconectado
def test_cerrar_el_generador_cancela_las_busquedas_pendientes(monkeypatch):
    import backend.app.main as main

    empezo = asyncio.Event()
    canceladas = []

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        if len(tracks) > 1:
            return {}  # la pista queda para la busqueda suelta
        empezo.set()
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            canceladas.append(str(tracks[0]["trackId"]))
            raise
        return {}

    # Dos pistas: asi la busqueda del album (2) no se confunde con la suelta.
    main = _instalar(None, monkeypatch,
                     [_song(1, "P1"), _song(2, "P2")], _enrich)

    async def correr():
        gen = main._album_match_eventos("999")
        assert (await gen.__anext__())[0] == "album"
        assert (await gen.__anext__())[0] == "tracks"
        # Este anext entra en as_completed y se queda colgado en las busquedas.
        paso = asyncio.create_task(gen.__anext__())
        await asyncio.wait_for(empezo.wait(), 1)
        paso.cancel()  # simula el corte del cliente
        with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration):
            await paso
        with contextlib.suppress(RuntimeError):
            await gen.aclose()
        return canceladas

    assert sorted(asyncio.run(correr())) == ["1", "2"]


@pytest.mark.parametrize("ruta", [
    "/api/album/abc/match?stream=1",
    "/api/album/abc/match",
])
def test_id_no_digito_da_404_tambien_en_stream(cliente, ruta):
    r = cliente.get(ruta)
    assert r.status_code == 404
    assert r.json()["detail"] == "album no encontrado"


def test_stream_fallo_de_itunes_devuelve_502_antes_de_abrir_el_stream(
        cliente, monkeypatch):
    import httpx
    from backend.app.sources import ITunesSource

    async def _roto(self, album_id):
        raise httpx.ConnectError("sin red")

    monkeypatch.setattr(ITunesSource, "lookup", _roto)
    r = cliente.get("/api/album/999/match?stream=1")
    assert r.status_code == 502
    assert r.json()["detail"] == "iTunes no respondio"

