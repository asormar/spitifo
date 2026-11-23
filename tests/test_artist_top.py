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


def _song(track_id, titulo, *, artista_id=777, dur=200_000,
          artista="Radiohead"):
    return {
        "wrapperType": "track", "kind": "song",
        "trackId": track_id, "collectionId": 999,
        "artistId": artista_id, "artistName": artista,
        "trackName": titulo, "collectionName": "OK Computer",
        "trackTimeMillis": dur,
        "artworkUrl100": "http://x/100x100bb.jpg",
        "releaseDate": "1997-05-21T07:00:00Z",
        "previewUrl": f"http://p/{track_id}",
        "trackViewUrl": f"http://t/{track_id}",
    }


def _video(track_id, titulo, *, canal="Radiohead"):
    return {
        "id": f"v{track_id}", "title": titulo, "uploader": canal,
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


def _youtube_por_consulta(monkeypatch, grupales, *, sueltas=None, falla_suelta=False):
    """Doble que distingue la busqueda del artista de la de cada pista."""
    consultas = []
    sueltas = sueltas or {}

    async def _videos(q, limit=40):
        consultas.append((q, limit))
        if q.startswith("Radiohead"):
            return list(grupales)
        if falla_suelta:
            raise RuntimeError("yt-dlp caido en la busqueda suelta")
        return next((list(v) for k, v in sueltas.items() if k in q), [])

    monkeypatch.setenv("YTDLP_ENABLED", "1")
    monkeypatch.setattr(BY_NAME["ytdlp"], "search_candidates", _videos)
    return consultas


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


# ------------------------------------------- segundo paso: busquedas sueltas
def test_top_busca_suelta_la_cancion_que_falto_en_el_grupo(cliente, monkeypatch):
    """Un video fuera de los 40 del artista se halla por artista + titulo."""
    crudos = [
        _song(1, "Creep"),
        _song(2, "Mesmerizer",
              artista="Satsuki, Hatsune Miku & Kasane Teto"),
    ]
    _canciones(monkeypatch, crudos)
    consultas = _youtube_por_consulta(
        monkeypatch, [_video(1, "Creep")],
        sueltas={"Mesmerizer": [_video(2, "Satsuki - Mesmerizer")]})

    r = cliente.get("/api/artist/777/top")
    assert r.status_code == 200
    creep, mesmerizer = r.json()["songs"]
    assert creep["extra"]["has_full"] is True
    assert mesmerizer["extra"]["has_full"] is True
    assert mesmerizer["extra"]["webpage_url"].endswith("v2")
    assert mesmerizer["extra"]["match_score"] >= 0.75
    assert any("Mesmerizer" in q and limit == 8 for q, limit in consultas)


def test_top_busqueda_suelta_rota_deja_preview_y_responde_200(cliente, monkeypatch):
    """Si la busqueda puntual revienta, esa pista sigue sin version completa."""
    crudos = [
        _song(1, "Creep"),
        _song(2, "Mesmerizer",
              artista="Satsuki, Hatsune Miku & Kasane Teto"),
    ]
    _canciones(monkeypatch, crudos)
    _youtube_por_consulta(monkeypatch, [_video(1, "Creep")], falla_suelta=True)

    r = cliente.get("/api/artist/777/top")
    assert r.status_code == 200
    creep, mesmerizer = r.json()["songs"]
    assert creep["extra"]["has_full"] is True
    assert mesmerizer["extra"]["has_full"] is False
    assert mesmerizer["extra"].get("webpage_url") is None
    assert mesmerizer["license"] == "preview de iTunes (30s)"


def test_top_busquedas_sueltas_como_maximo_tres(cliente, monkeypatch):
    """El segundo paso no dispara una busqueda por pista sin tope."""
    _canciones(monkeypatch, [_song(i, f"Cancion {i}") for i in range(5)])
    activas = 0
    pico = 0

    async def _videos(q, limit=40):
        nonlocal activas, pico
        if q == "Radiohead":
            return []
        activas += 1
        pico = max(pico, activas)
        await asyncio.sleep(0.01)
        activas -= 1
        i = int(q.split()[-1])
        return [_video(i, f"Radiohead - Cancion {i}")]

    monkeypatch.setenv("YTDLP_ENABLED", "1")
    monkeypatch.setattr(BY_NAME["ytdlp"], "search_candidates", _videos)

    r = cliente.get("/api/artist/777/top")
    assert r.status_code == 200
    assert all(t["extra"]["has_full"] for t in r.json()["songs"])
    assert 2 <= pico <= 3


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


def test_top_no_cachea_fallo_de_match(cliente, monkeypatch):
    """Un YouTube caido es transitorio: no se guarda media hora sin videos."""
    _canciones(monkeypatch, [_song(1, "Creep")])
    _youtube(monkeypatch, [], enabled=True)
    from backend.app import matcher
    intentos = []

    async def _match_roto(*args, **kwargs):
        intentos.append(1)
        raise RuntimeError("youtube caido")

    monkeypatch.setattr(matcher, "enrich_with_ytdlp", _match_roto)
    a = cliente.get("/api/artist/777/top")
    b = cliente.get("/api/artist/777/top")
    assert a.status_code == b.status_code == 200
    assert len(intentos) == 2  # el segundo reintenta, no sirve la cache del fallo


def test_top_concurrente_un_solo_llamado(cliente, monkeypatch):
    """Dos pedidos frios a la vez comparten lookup y match, no se duplican."""
    vistos = []

    async def _top(self, artista_id, limit=5):
        vistos.append(artista_id)
        await asyncio.sleep(0.01)
        return [_song(1, "Creep")]

    monkeypatch.setattr(ITunesSource, "artist_top_songs", _top)
    monkeypatch.setenv("YTDLP_ENABLED", "0")
    from backend.app.main import artist_top_songs

    class _Req:
        path_params = {"id": "777"}

    async def dos():
        return await asyncio.gather(
            artist_top_songs(_Req()), artist_top_songs(_Req()))

    resp = asyncio.run(dos())
    assert [r.status_code for r in resp] == [200, 200]
    assert vistos == ["777"]


def test_artist_top_songs_no_cachea_en_la_fuente():
    """La unica cache del top esta en el endpoint; la fuente vuelve a iTunes."""
    vistos = []

    def handler(request):
        vistos.append(1)
        return httpx.Response(200, json={"results": [_song(1, "Creep")]})

    fuente = ITunesSource()
    fuente._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        asyncio.run(fuente.artist_top_songs(777, limit=10))
        asyncio.run(fuente.artist_top_songs(777, limit=10))
    finally:
        asyncio.run(fuente.aclose())
    assert len(vistos) == 2


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


def test_clave_top_no_confunde_partes_ni_colaboraciones():
    """Solo se recorta un sufijo si es de edicion: Parte 2 y feat. son titulo."""
    from backend.app.main import _top_song_key
    assert _top_song_key(_song(1, "Theme (Part 1)")) != _top_song_key(
        _song(2, "Theme (Part 2)"))
    assert _top_song_key(_song(1, "Song (feat. X)")) != _top_song_key(
        _song(2, "Song"))
    assert _top_song_key(_song(1, "Song (feat. X)")) == _top_song_key(
        _song(2, "SONG (FEAT. X)"))


def test_clave_top_colapsa_remastered_y_live():
    from backend.app.main import _top_song_key
    claves = [_top_song_key(_song(i, t)) for i, t in enumerate([
        "Creep", "Creep (Remastered)", "Creep (Live)", "Creep (Deluxe)",
        "Creep (Bonus Track)", "Creep - Live",
    ], 1)]
    assert len(set(claves)) == 1


def test_clave_top_titulos_vacios_no_colapsan():
    """Dos canciones sin titulo siguen siendo dos por su trackId."""
    from backend.app.main import _top_song_key
    assert _top_song_key(_song(1, "")) != _top_song_key(_song(2, "   "))
    assert _top_song_key(_song(1, "")) == _top_song_key(_song(1, ""))
    assert _top_song_key(_song(1, "(Live)")) == _top_song_key(_song(1, ""))


def test_top_incluye_canciones_acreditadas_a_otro_que_nombran_al_artista(
        cliente, monkeypatch):
    """En Kasane Teto casi todo va a nombre del productor: el credito o el
    "feat." del titulo la nombran y la cancion se queda. Lo ajeno se va."""
    crudos = [
        {"wrapperType": "artist", "artistId": 777, "artistName": "Kasane Teto"},
        _song(1, "Mesmerizer", artista_id=11,
              artista="Satsuki, Hatsune Miku & Kasane Teto"),
        _song(2, "Refrain (feat. Kasane Teto)", artista_id=12,
              artista="HAL@修羅場P"),
        _song(3, "Otra cosa", artista_id=13, artista="Alguien Mas"),
        _song(4, "Teto Territory", artista="Kasane Teto"),
    ]
    _canciones(monkeypatch, crudos)
    _youtube(monkeypatch, [], enabled=False)

    body = cliente.get("/api/artist/777/top").json()
    assert body["name"] == "Kasane Teto"
    assert [t["title"] for t in body["songs"]] == [
        "Mesmerizer", "Refrain (feat. Kasane Teto)", "Teto Territory"]


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
    assert [t.get("trackId") for t in salida] == [1, None]
    # el wrapper del artista se conserva: el endpoint saca de ahi el nombre
    assert salida[1]["wrapperType"] == "artist"
