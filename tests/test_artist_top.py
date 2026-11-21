"""Top de artistas: canciones destacadas listas para tocar, sin red.

iTunes y YouTube se reemplazan por dobles, igual que en test_artists.py: ningun
test pega a internet. Cubre el match, YouTube apagado, fallo de red, cache y el
tope de cinco canciones.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

from backend.app.sources import BY_NAME, ITunesSource


def _song(track_id, titulo, *, artista_id=777, dur=200_000):
    return {
        "wrapperType": "track", "kind": "song",
        "trackId": track_id, "collectionId": 999,
        "artistId": artista_id, "artistName": "Radiohead",
        "trackName": titulo, "collectionName": "OK Computer",
        "trackTimeMillis": dur,
        "artworkUrl100": "http://x/100x100bb.jpg",
        "releaseDate": "1997-05-21T07:00:00Z",
        "previewUrl": f"http://p/{track_id}",
        "trackViewUrl": f"http://t/{track_id}",
    }


def _video(track_id, titulo):
    return {
        "id": f"v{track_id}", "title": titulo, "uploader": "Radiohead",
        "duration": 200, "webpage_url": f"https://www.youtube.com/watch?v=v{track_id}",
    }


@pytest.fixture(autouse=True)
def _top_cache_limpio():
    """La cache del top no filtra un test al siguiente."""
    from backend.app import main
    main._ARTIST_TOP_CACHE.clear()
    yield
    main._ARTIST_TOP_CACHE.clear()


def _canciones(monkeypatch, crudos):
    async def _top(self, artista_id, limit=5):
        return crudos

    monkeypatch.setattr(ITunesSource, "artist_top_songs", _top)


def _youtube(monkeypatch, videos, enabled=True):
    monkeypatch.setenv("YTDLP_ENABLED", "1" if enabled else "0")

    async def _videos(q, limit=40):
        return list(videos)

    monkeypatch.setattr(BY_NAME["ytdlp"], "search_candidates", _videos)


# ------------------------------------------------------------------ happy path
def test_top_matchea_como_buscar(cliente, monkeypatch):
    crudos = [_song(1, "Creep"), _song(2, "Karma Police"), _song(3, "No Surprises")]
    _canciones(monkeypatch, crudos)
    _youtube(monkeypatch, [_video(1, "Creep"), _video(2, "Karma Police"),
                           _video(3, "No Surprises")])

    r = cliente.get("/api/artist/777/top")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == 777 and body["name"] == "Radiohead"
    assert [t["title"] for t in body["songs"]] == [
        "Creep", "Karma Police", "No Surprises"]
    for t in body["songs"]:
        assert t["extra"]["has_full"] is True
        assert t["extra"]["needs_resolve"] is True
        assert t["extra"]["downloader"] == "ytdlp"
        assert t["extra"]["webpage_url"].startswith("https://www.youtube.com/")
        assert t["extra"]["match_score"] >= 0.75
        assert "YouTube" in t["license"]


# ---------------------------------------------------------------- YTDLP = 0
def test_top_sin_youtube_son_previews(cliente, monkeypatch):
    _canciones(monkeypatch, [_song(1, "Creep"), _song(2, "Karma Police")])
    _youtube(monkeypatch, [], enabled=False)

    r = cliente.get("/api/artist/777/top")
    assert r.status_code == 200
    canciones = r.json()["songs"]
    assert len(canciones) == 2
    for t in canciones:
        assert t["extra"]["has_full"] is False
        assert t["extra"].get("webpage_url") is None
        assert t["preview_url"]
        assert t["license"] == "preview de iTunes (30s)"


# ------------------------------------------------------------------- errores
@pytest.mark.parametrize("error", [
    httpx.ConnectError("sin red"),
    httpx.HTTPStatusError("500", request=httpx.Request(
        "GET", "https://itunes.apple.com/lookup"),
        response=httpx.Response(500)),
    RuntimeError("boom"),
])
def test_top_fallo_devuelve_lista_vacia_con_200(cliente, monkeypatch, error):
    async def _roto(self, artista_id, limit=5):
        raise error

    monkeypatch.setattr(ITunesSource, "artist_top_songs", _roto)
    monkeypatch.setenv("YTDLP_ENABLED", "0")
    r = cliente.get("/api/artist/777/top")
    assert r.status_code == 200
    assert r.json() == {"id": 777, "name": None, "songs": []}


def test_top_id_desconocido_devuelve_vacio(cliente, monkeypatch):
    _canciones(monkeypatch, [])
    monkeypatch.setenv("YTDLP_ENABLED", "0")
    r = cliente.get("/api/artist/999999/top")
    assert r.status_code == 200
    assert r.json()["songs"] == []


def test_top_id_no_digito_da_422(cliente):
    assert cliente.get("/api/artist/abc/top").status_code == 422


# ---------------------------------------------------------------------- cache
def test_top_cache_hit_no_repite_lector(cliente, monkeypatch):
    vistos = []

    async def _top(self, artista_id, limit=5):
        vistos.append(artista_id)
        return [_song(1, "Creep")]

    monkeypatch.setattr(ITunesSource, "artist_top_songs", _top)
    monkeypatch.setenv("YTDLP_ENABLED", "0")
    a = cliente.get("/api/artist/777/top")
    b = cliente.get("/api/artist/777/top")
    assert a.status_code == b.status_code == 200
    assert a.json() == b.json()
    assert vistos == ["777"]


def test_top_no_cachea_fallo_de_red(cliente, monkeypatch):
    vistos = []

    async def _roto(self, artista_id, limit=5):
        vistos.append(artista_id)
        if len(vistos) == 1:
            raise httpx.ConnectError("sin red")
        return [_song(1, "Creep")]

    monkeypatch.setattr(ITunesSource, "artist_top_songs", _roto)
    monkeypatch.setenv("YTDLP_ENABLED", "0")
    assert cliente.get("/api/artist/777/top").json()["songs"] == []
    assert len(cliente.get("/api/artist/777/top").json()["songs"]) == 1
    assert vistos == ["777", "777"]


# --------------------------------------------------------------------- limite
def test_top_maximo_cinco_canciones(cliente, monkeypatch):
    crudos = [_song(i, f"Cancion {i}") for i in range(8)]
    crudos.append(_song(99, "De otro", artista_id=999))
    _canciones(monkeypatch, crudos)
    monkeypatch.setenv("YTDLP_ENABLED", "0")
    r = cliente.get("/api/artist/777/top")
    assert r.status_code == 200
    canciones = r.json()["songs"]
    assert len(canciones) == 5
    assert [t["title"] for t in canciones] == [f"Cancion {i}" for i in range(5)]


# --------------------------------------------------------------------- dedupe
def test_top_dedupe_sufijos_de_edicion(cliente, monkeypatch):
    crudos = [
        _song(1, "Creep"),
        _song(2, "Creep (Remastered)"),
        _song(3, "Creep - Live"),
        _song(4, "Creep (Acoustic)"),
        _song(5, "High and Dry"),
    ]
    _canciones(monkeypatch, crudos)
    monkeypatch.setenv("YTDLP_ENABLED", "0")
    r = cliente.get("/api/artist/777/top")
    assert r.status_code == 200
    assert [t["title"] for t in r.json()["songs"]] == ["Creep", "High and Dry"]


def test_top_dedupe_plega_acentos_y_mayusculas(cliente, monkeypatch):
    _canciones(monkeypatch, [
        _song(1, "Canción"),
        _song(2, "CANCION (Live)"),
        _song(3, "Otra"),
    ])
    monkeypatch.setenv("YTDLP_ENABLED", "0")
    r = cliente.get("/api/artist/777/top")
    assert [t["title"] for t in r.json()["songs"]] == ["Canción", "Otra"]


def test_top_dedupe_deja_cinco_distintos(cliente, monkeypatch):
    """Con duplicados delante, el tope de cinco se llena con temas distintos."""
    crudos = [
        _song(1, "Creep"),
        _song(2, "Creep (Remastered 2015)"),
        _song(3, "Karma Police"),
        _song(4, "Karma Police - Live"),
        _song(5, "High and Dry"),
        _song(6, "Fake Plastic Trees"),
        _song(7, "No Surprises"),
        _song(8, "Let Down"),
    ]
    _canciones(monkeypatch, crudos)
    monkeypatch.setenv("YTDLP_ENABLED", "0")
    r = cliente.get("/api/artist/777/top")
    assert [t["title"] for t in r.json()["songs"]] == [
        "Creep", "Karma Police", "High and Dry", "Fake Plastic Trees",
        "No Surprises",
    ]


def test_clave_top_no_confunde_temas_distintos():
    from backend.app.main import _top_song_key
    assert _top_song_key(_song(1, "Creep")) == _top_song_key(
        _song(2, "Creep (Remastered)"))
    assert _top_song_key(_song(1, "Creep")) != _top_song_key(
        _song(2, "Creepy"))
    assert _top_song_key(_song(1, "High and Dry")) == _top_song_key(
        _song(2, "HIGH AND DRY [Live]"))


# ------------------------------------------------------------ cliente iTunes
def test_artist_top_songs_llama_lookup_con_entity_song():
    vistos = {}

    def handler(request):
        vistos.update(dict(request.url.params))
        return httpx.Response(200, json={"results": [
            _song(1, "Creep"),
            {"wrapperType": "artist", "artistId": 777},
        ]})

    fuente = ITunesSource()
    fuente._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        salida = asyncio.run(fuente.artist_top_songs(777, limit=10))
    finally:
        asyncio.run(fuente.aclose())
    assert vistos["id"] == "777"
    assert vistos["entity"] == "song"
    assert vistos["limit"] == "10"  # se pide de mas para dedupe antes del tope
    assert [t["trackId"] for t in salida] == [1]
