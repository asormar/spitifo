"""Artistas: id en canciones/albumes, busqueda y discografia.

Todo OFFLINE: iTunes se reemplaza por dobles, como en test_albums.py. No se
hace ninguna llamada de red: las respuestas crudas son dicts armados a mano.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

from backend.app.models import Track
from backend.app.sources import ITunesSource


def _song(track_id, titulo, *, disco=1, pista=1, artista_id=777):
    """Item de /search con artistId, como lo devuelve iTunes."""
    return {
        "wrapperType": "track", "kind": "song",
        "trackId": track_id, "collectionId": 999, "artistId": artista_id,
        "trackName": titulo, "artistName": "Linkin Park",
        "collectionName": "Meteora", "trackTimeMillis": 200_000,
        "artworkUrl100": "http://x/100x100bb.jpg",
        "releaseDate": "2003-03-25T07:00:00Z",
        "collectionExplicitness": "notExplicit",
        "trackNumber": pista, "discNumber": disco,
        "trackCount": 12, "discCount": 2,
        "previewUrl": "http://p", "trackViewUrl": "http://t",
        "primaryGenreName": "Rock",
    }


def _collection(titulo, *, id=1, tracks=10, fecha="2010-01-01T07:00:00Z",
                explicit=False, artwork="http://x/100x100bb.jpg",
                artista_id=777, artista="Linkin Park", copyright=""):
    """Coleccion cruda de /lookup con entity=album."""
    return {
        "wrapperType": "collection", "collectionId": id,
        "collectionName": titulo, "artistName": artista,
        "artistId": artista_id, "releaseDate": fecha,
        "trackCount": tracks,
        "artworkUrl100": artwork,
        "collectionExplicitness": "explicit" if explicit else "notExplicit",
        "copyright": copyright,
    }


def _artista(id=777, nombre="Linkin Park", genero="Rock"):
    return {
        "wrapperType": "artist", "artistId": id,
        "artistName": nombre, "primaryGenreName": genero,
    }


async def _enrich_vacio(tracks, query, ysrc, limit=40):
    return {}


# ------------------------------------------------ artistId en pistas y albumes
def test_search_matched_lleva_artist_id_en_extra(monkeypatch):
    import backend.app.main as main

    raw = _song(111, "Numb", artista_id=777)
    sin_artista = {"trackId": 112, "trackName": "Otro", "artistName": "X"}

    async def _raw(self, q, limit=20):
        return [raw, sin_artista]

    monkeypatch.setattr("backend.app.sources.ITunesSource._raw_search", _raw)
    monkeypatch.setattr("backend.app.matcher.enrich_with_ytdlp", _enrich_vacio)

    data = asyncio.run(main._search_matched("numb", 10))
    completo = data["results"][0]["extra"]
    assert completo["artist_id"] == 777
    assert completo["collection_id"] == 999
    assert data["results"][1]["extra"]["artist_id"] is None


def test_itunes_track_lleva_artist_id_en_extra():
    import backend.app.main as main

    track = main._itunes_track(_song(1, "Uno", artista_id=123), checked=False)
    assert track.extra["artist_id"] == 123
    assert isinstance(track, Track)


def test_albums_search_incluye_artist_id(cliente, monkeypatch):
    async def _search(self, q, limit=8):
        return [_collection("Meteora", id=999, artista_id=777)]

    monkeypatch.setattr(ITunesSource, "search_albums", _search)
    r = cliente.get("/api/albums/search", params={"q": "meteora"})
    assert r.status_code == 200
    album = r.json()["albums"][0]
    assert album["artist_id"] == 777
    assert album["id"] == 999
    assert album["title"] == "Meteora"


# ------------------------------------------------------ /api/artists/search
def test_artists_search_forma(cliente, monkeypatch):
    crudos = [
        {"artistId": 777, "artistName": "Linkin Park",
         "primaryGenreName": "Rock"},
        {"artistId": 1, "artistName": "Queen", "primaryGenreName": None},
    ]
    vistos = {}

    async def _search(self, q, limit=5):
        vistos.update(q=q, limit=limit)
        return crudos

    monkeypatch.setattr(ITunesSource, "search_artists", _search)
    r = cliente.get("/api/artists/search", params={"q": "linkin"})
    assert r.status_code == 200
    assert vistos == {"q": "linkin", "limit": 5}
    assert r.json() == {
        "query": "linkin",
        "results": [
            {"id": 777, "name": "Linkin Park", "genre": "Rock"},
            {"id": 1, "name": "Queen", "genre": None},
        ],
    }


def test_artists_search_respeta_limite(cliente, monkeypatch):
    vistos = {}

    async def _search(self, q, limit=5):
        vistos["limit"] = limit
        return []

    monkeypatch.setattr(ITunesSource, "search_artists", _search)
    r = cliente.get("/api/artists/search", params={"q": "x", "limit": 3})
    assert r.status_code == 200
    assert vistos["limit"] == 3


@pytest.mark.parametrize("params", [{}, {"q": ""}, {"q": "a" * 201},
                                    {"q": "x", "limit": 0},
                                    {"q": "x", "limit": 21},
                                    {"q": "x", "limit": "no"}])
def test_artists_search_parametros_invalidos_dan_422(cliente, params):
    r = cliente.get("/api/artists/search", params=params)
    assert r.status_code == 422


def test_artists_search_fallo_da_lista_vacia(cliente, monkeypatch):
    async def _roto(self, q, limit=5):
        raise RuntimeError("iTunes no contesta")

    monkeypatch.setattr(ITunesSource, "search_artists", _roto)
    r = cliente.get("/api/artists/search", params={"q": "x"})
    assert r.status_code == 200
    assert r.json() == {"query": "x", "results": []}


def test_search_artists_usa_entity_musicartist_y_filtra():
    vistos = {}

    def handler(request):
        vistos.update(dict(request.url.params))
        return httpx.Response(200, json={"results": [
            {"artistId": 1, "artistName": "A"},
            {"artistName": "sin id"},
            {"artistId": 2},
        ]})

    fuente = ITunesSource()
    fuente._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        salida = asyncio.run(fuente.search_artists("linkin", limit=4))
    finally:
        asyncio.run(fuente.aclose())
    assert vistos["entity"] == "musicArtist"
    assert vistos["media"] == "music"
    assert vistos["term"] == "linkin"
    assert vistos["limit"] == "4"
    assert salida == [{"artistId": 1, "artistName": "A"}]


# ------------------------------------------------- clasificacion (funcion pura)
@pytest.mark.parametrize("titulo,pistas,esperado", [
    ("Hybrid Theory", 12, "album"),
    ("Hybrid Theory (2001)", 11, "album"),
    ("Numb - Single", 2, "single"),
    ("Numb - EP", 3, "single"),
    ("Cancion suelta", 2, "single"),
    ("Numb - Single", 12, "single"),       # el sufijo gana aunque tenga pistas
    ("Live in Texas", 14, "live"),
    ("En Vivo", 12, "live"),               # acentos y mayusculas no importan
    ("En directo", 12, "live"),
    ("Ao Vivo", 12, "live"),
    ("MTV Unplugged", 12, "live"),
    ("Unplugged", 12, "live"),
    ("En concierto", 12, "live"),
    ("Concierto en Madrid", 12, "live"),
    ("X (Live at Wembley)", 12, "live"),
    ("Alive", 12, "album"),                # \b no deja confundir "Alive"
    ("Oliver", 12, "album"),               # ni "Oliver"
    ("A live-album", 12, "live"),          # guion es limite de palabra
    ("Gira Me Veras Volver, Vol. 1", 14, "live"),
    ("M72 World Tour: Mexico City", 4, "live"),
    ("Tour de France", 12, "album"),       # "tour" suelto no es en vivo
    ("Me Veras Volver (Hits & Mas)", 18, "compilation"),
    ("Lo Esencial: Soda Stereo", 15, "compilation"),
    ("20 Grandes Éxitos", 22, "compilation"),
    ("Zona de Promesas (Mixes 1984-1993)", 10, "compilation"),
    ("Greatest Hits Live", 14, "live"),    # un directo de exitos es directo
])
def test_clasificacion_de_lanzamientos(titulo, pistas, esperado):
    from backend.app.main import classify_release

    raw = {"collectionName": titulo, "trackCount": pistas}
    assert classify_release(raw) == esperado


@pytest.mark.parametrize("copyright,esperado", [
    ("℗ Compilación: (P) 2006 Sony", "compilation"),
    ("℗ Compilation (P) 2012 Sony", "compilation"),
    ("℗ 1983, 1984, 1985, 1986 Sony", "compilation"),
    ("℗ 1977, 2009 Kling Klang", "album"),  # original + remaster no alcanza
    ("℗ 1990 Sony", "album"),
])
def test_clasificacion_por_copyright(copyright, esperado):
    from backend.app.main import classify_release

    raw = {"collectionName": "Disco", "trackCount": 10,
           "copyright": copyright}
    assert classify_release(raw) == esperado


def test_clasificacion_sin_track_count():
    from backend.app.main import classify_release

    assert classify_release({"collectionName": "Directo"}) == "album"
    assert classify_release({}) == "album"


def test_normalizacion_quita_sufijos_y_calificadores():
    from backend.app.main import _normalized_title

    assert _normalized_title("Numb - Single") == "numb"
    assert _normalized_title("Album (Remastered)") == "album"
    assert _normalized_title("Album (Deluxe Edition)") == "album"
    assert _normalized_title("Álbum (Remasterizado 2007)") == "album"
    assert _normalized_title(
        "Ride (Remastered) [2016 Remastered Version]") == "ride"
    # un parentesis con significado NO se pierde
    assert _normalized_title("Concierto (En Vivo)") == "concierto (en vivo)"


# ------------------------------------------------------- /api/artist/{id}
def _discografia_cliente(cliente, monkeypatch, crudos):
    async def _albums(self, artista_id):
        return crudos

    monkeypatch.setattr(ITunesSource, "artist_albums", _albums)
    return cliente.get("/api/artist/777")


def test_artista_detalle_forma_orden_y_clasificacion(cliente, monkeypatch):
    crudos = [
        _artista(),
        _collection("Concierto en Madrid", id=3, tracks=15,
                    fecha="2020-06-01T07:00:00Z",
                    artwork="http://x/live.jpg"),
        _collection("Meteora", id=1, tracks=12, fecha="2003-03-25T07:00:00Z",
                    explicit=True, artwork="http://x/100x100bb.jpg"),
        _collection("Hybrid Theory", id=2, tracks=12,
                    fecha="2000-10-09T07:00:00Z", artwork="http://x/2000.jpg"),
        _collection("Numb - Single", id=4, tracks=2,
                    fecha="2003-04-01T07:00:00Z"),
    ]
    r = _discografia_cliente(cliente, monkeypatch, crudos)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"id", "name", "genre", "artwork_url",
                         "albums", "live", "compilations", "singles"}
    assert (body["id"], body["name"], body["genre"]) == (
        777, "Linkin Park", "Rock")
    # la portada del artista es la del disco de estudio mas nuevo
    assert body["artwork_url"] == "http://x/300x300bb.jpg"
    assert [a["id"] for a in body["albums"]] == [1, 2]
    assert body["albums"][0] == {
        "id": 1, "title": "Meteora", "artist": "Linkin Park",
        "year": "2003", "track_count": 12,
        "artwork_url": "http://x/300x300bb.jpg", "explicit": True,
    }
    assert [a["title"] for a in body["live"]] == ["Concierto en Madrid"]
    assert [a["title"] for a in body["singles"]] == ["Numb"]


def test_artista_orden_mas_nuevo_primero(cliente, monkeypatch):
    crudos = [
        _artista(),
        _collection("Viejo", id=1, fecha="1999-01-01T07:00:00Z"),
        _collection("Nuevo", id=2, fecha="2021-01-01T07:00:00Z"),
        _collection("Medio", id=3, fecha="2010-01-01T07:00:00Z"),
    ]
    r = _discografia_cliente(cliente, monkeypatch, crudos)
    assert [a["title"] for a in r.json()["albums"]] == [
        "Nuevo", "Medio", "Viejo"]


def test_artista_dedupe_explicito_y_remasterizado(cliente, monkeypatch):
    crudos = [
        _artista(),
        _collection("Meteora", id=1, tracks=12, explicit=False,
                    fecha="2003-03-25T07:00:00Z"),
        _collection("Meteora", id=2, tracks=12, explicit=True,
                    fecha="2003-03-25T07:00:00Z"),
        _collection("Meteora (Remastered)", id=3, tracks=12, explicit=False,
                    fecha="2015-01-01T07:00:00Z"),
        _collection("Meteora (Deluxe Edition)", id=4, tracks=15,
                    explicit=False, fecha="2015-01-01T07:00:00Z"),
    ]
    r = _discografia_cliente(cliente, monkeypatch, crudos)
    albums = r.json()["albums"]
    assert len(albums) == 1
    # gana el explicito; el titulo conservado es el de la entrada elegida
    assert albums[0]["id"] == 2
    assert albums[0]["title"] == "Meteora"
    assert albums[0]["explicit"] is True


def test_artista_dedupe_prefiere_la_edicion_original(cliente, monkeypatch):
    """Para bajar la discografia, la edicion de 9 pistas y no la de 63."""
    crudos = [
        _artista(),
        _collection("Ride (Deluxe Edition)", id=1, tracks=63,
                    fecha="1984-07-27T07:00:00Z"),
        _collection("Ride (Remastered) [2016 Remastered Version]", id=2,
                    tracks=9, fecha="1984-07-27T07:00:00Z"),
        _collection("Ride", id=3, tracks=9, fecha="2016-01-01T07:00:00Z"),
    ]
    r = _discografia_cliente(cliente, monkeypatch, crudos)
    albums = r.json()["albums"]
    assert len(albums) == 1 and albums[0]["id"] == 2


def test_artista_separa_recopilatorios(cliente, monkeypatch):
    crudos = [
        _artista(),
        _collection("Signos", id=1),
        _collection("Lo Esencial", id=2),
        _collection("Obras Cumbres", id=3,
                    copyright="℗ Compilación: (P) 2006 Sony"),
        # mismo disco, reeditado: el copyright junta anios pero ya es album
        _collection("El Leon", id=4, copyright="℗ 1992, 1993, 2008 Sony"),
        _collection("El Leon (Remasterizado 2008)", id=5),
    ]
    body = _discografia_cliente(cliente, monkeypatch, crudos).json()
    assert sorted(a["id"] for a in body["albums"]) == [1, 5]
    assert sorted(a["id"] for a in body["compilations"]) == [2, 3]


def test_artista_descarta_compilacion_de_otro_artista(cliente, monkeypatch):
    crudos = [
        _artista(),
        _collection("Meteora", id=1),
        _collection("Varios exitos", id=2, artista_id=999,
                    artista="Varios artistas"),
    ]
    r = _discografia_cliente(cliente, monkeypatch, crudos)
    assert [a["title"] for a in r.json()["albums"]] == ["Meteora"]


def test_artista_sin_wrapper_da_404(cliente, monkeypatch):
    async def _albums(self, artista_id):
        return [_collection("Meteora", id=1)]

    monkeypatch.setattr(ITunesSource, "artist_albums", _albums)
    r = cliente.get("/api/artist/777")
    assert r.status_code == 404
    assert "artista" in r.json()["detail"].lower()


@pytest.mark.parametrize("fallo", ["red", "http"])
def test_artista_fallo_de_itunes_da_502(cliente, monkeypatch, fallo):
    if fallo == "red":
        error = httpx.ConnectError("sin red")
    else:
        req = httpx.Request("GET", "https://itunes.apple.com/lookup")
        error = httpx.HTTPStatusError(
            "500", request=req, response=httpx.Response(500, request=req))

    async def _roto(self, artista_id):
        raise error

    monkeypatch.setattr(ITunesSource, "artist_albums", _roto)
    r = cliente.get("/api/artist/777")
    assert r.status_code == 502
    assert r.json()["detail"] == "iTunes no respondio"


def test_artista_id_no_digito_da_422(cliente, monkeypatch):
    vistos = []

    async def _albums(self, artista_id):
        vistos.append(artista_id)
        return [_artista()]

    monkeypatch.setattr(ITunesSource, "artist_albums", _albums)
    r = cliente.get("/api/artist/abc")
    assert r.status_code == 422
    assert vistos == []


def test_artista_sin_discos_devuelve_listas_vacias(cliente, monkeypatch):
    r = _discografia_cliente(cliente, monkeypatch, [_artista()])
    assert r.status_code == 200
    body = r.json()
    assert body["albums"] == [] and body["live"] == []
    assert body["singles"] == [] and body["artwork_url"] is None


def test_artist_albums_llama_lookup_con_entity_album():
    vistos = {}

    def handler(request):
        vistos.update(dict(request.url.params))
        return httpx.Response(200, json={"results": [_artista()]})

    fuente = ITunesSource()
    fuente._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        asyncio.run(fuente.artist_albums(777))
    finally:
        asyncio.run(fuente.aclose())
    assert vistos["id"] == "777"
    assert vistos["entity"] == "album"
    assert vistos["limit"] == "200"
