"""Alias japoneses de iTunes: OFFLINE, con `MockTransport` y Youtube falso.

Una ficha de iTunes suele venir en latin y el video de YouTube (o el storefront
jp) en japones, y al reves. Sin alias, el matcher no empareja y el veredicto
dice "NO es lo que buscabas" aunque sea la misma cancion. Ningun test toca la
red: el lookup jp va por `MockTransport` y el buscador de videos es el doble de
`conftest`.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager

import httpx
import pytest
from starlette.testclient import TestClient

from backend.app import matcher
from backend.app.identify import verdict
from backend.app.main import create_app, link_saved_download
from backend.app.matcher import MIN_SCORE, enrich_with_ytdlp, score_pair
from backend.app.models import Track
from backend.app.saved import song_id
from backend.app.sources import ITunesSource
from backend.app.storage import set_storage
from backend.app.storage.local import LocalStorage
from backend.app.ytdlp_source import identity_best_reference, identity_reference

TRACK_ID = 1234567890
DEFAULT = {"trackId": TRACK_ID, "trackName": "Mesmerizer", "artistName": "Satsuki"}
JP = {"trackId": TRACK_ID, "trackName": "メズマライザー", "artistName": "サツキ"}


def _fuente(handler) -> ITunesSource:
    src = ITunesSource()
    src._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return src


# --------------------------------------------------------------- lookup jp
def test_lookup_aliases_devuelve_solo_lo_que_difiere():
    vistos = []

    def handler(req):
        vistos.append(req)
        return httpx.Response(200, json={"results": [JP]})

    alias = asyncio.run(_fuente(handler).lookup_aliases(dict(DEFAULT)))
    assert alias == {"title": "メズマライザー", "artist": "サツキ"}
    assert vistos[0].url.params["id"] == str(TRACK_ID)
    assert vistos[0].url.params["country"] == "jp"


def test_lookup_aliases_sin_diferencia_no_devuelve_nada():
    """Si el storefront jp dice lo mismo, no hay alias que agregar."""
    def handler(req):
        return httpx.Response(200, json={"results": [dict(DEFAULT)]})

    assert asyncio.run(_fuente(handler).lookup_aliases(dict(DEFAULT))) == {}


def test_lookup_aliases_fallo_de_red_no_tumba():
    """Best effort: un timeout/fallo de red es simplemente 'sin alias'."""
    def handler(req):
        raise httpx.ConnectError("sin red")

    assert asyncio.run(_fuente(handler).lookup_aliases(dict(DEFAULT))) == {}


def test_lookup_aliases_respuesta_mala_no_tumba():
    def handler(req):
        return httpx.Response(503, json={})

    assert asyncio.run(_fuente(handler).lookup_aliases(dict(DEFAULT))) == {}


def test_lookup_aliases_cachea_como_el_resto_de_itunes():
    """Dos busquedas seguidas no piden dos veces el mismo lookup jp."""
    llamadas = []

    def handler(req):
        llamadas.append(req)
        return httpx.Response(200, json={"results": [JP]})

    src = _fuente(handler)
    asyncio.run(src.lookup_aliases(dict(DEFAULT)))
    asyncio.run(src.lookup_aliases(dict(DEFAULT)))
    assert len(llamadas) == 1


# ----------------------------------------------------------------- matcher
def test_matcher_acepta_refrain_en_japones():
    """La ficha dice Refrain (feat. Kasane Teto), el video dice リフレイン."""
    s, por_que = score_pair(
        "Refrain (feat. Kasane Teto)", "HAL@修羅場P", 200,
        "リフレイン", "Kasane Teto Official", 200,
        aliases={"title": "リフレイン"})
    assert s >= MIN_SCORE
    assert por_que == "canal+dur"


def test_matcher_acepta_satsuki_en_japones():
    """Mesmerizer/Satsuki (iTunes) contra サツキ - メズマライザー (video)."""
    s, por_que = score_pair(
        "Mesmerizer", "Satsuki", 200,
        "サツキ - メズマライザー", "サツキ", 200,
        aliases={"title": "メズマライザー", "artist": "サツキ"})
    assert s >= MIN_SCORE
    assert por_que == "canal+dur"


def test_matcher_acepta_latin_cuando_la_ficha_es_japonesa():
    """Y al reves: la ficha en japones y el video en latin."""
    s, _ = score_pair(
        "メズマライザー", "サツキ", 200,
        "Satsuki - Mesmerizer", "Satsuki", 200,
        aliases={"title": "Mesmerizer", "artist": "Satsuki"})
    assert s >= MIN_SCORE


def test_matcher_sin_alias_sigue_rechazando():
    """El alias es la unica senal: sin el, no se inventa un match."""
    assert score_pair("Mesmerizer", "Satsuki", 200,
                      "サツキ - メズマライザー", "サツキ", 200) == (0.0, "sin-artista")


def test_enrich_with_ytdlp_uso_de_alias(monkeypatch, fake_ytdlp):
    """El alias se pide una vez y se guarda en la ficha cruda para el Track."""
    raw = {**DEFAULT, "trackTimeMillis": 200000}
    videos = [{"id": "v1", "title": "サツキ - メズマライザー",
               "uploader": "サツキ", "duration": 200}]

    async def _alias(ficha):
        return ({"title": "メズマライザー", "artist": "サツキ"}
                if ficha.get("trackId") == TRACK_ID else {})

    monkeypatch.setattr(matcher, "_aliases_for", _alias)
    res = asyncio.run(enrich_with_ytdlp([raw], "Mesmerizer Satsuki", fake_ytdlp(videos)))
    assert res[str(TRACK_ID)]["video"]["id"] == "v1"
    assert raw["aliases"] == {"title": "メズマライザー", "artist": "サツキ"}


def test_enrich_sin_japones_no_pide_alias(monkeypatch, fake_ytdlp):
    """Cada alias es un lookup a iTunes: una busqueda sin kana ni kanji no
    gasta ninguno."""
    pedidos = []

    async def _alias(ficha):
        pedidos.append(ficha.get("trackId"))
        return {}

    monkeypatch.setattr(matcher, "_aliases_for", _alias)
    raw = {"trackId": 1, "trackName": "Creep", "artistName": "Radiohead",
           "trackTimeMillis": 238000}
    videos = [{"id": "v1", "title": "Radiohead - Nope", "uploader": "Someone",
               "duration": 100}]
    asyncio.run(enrich_with_ytdlp([raw], "radiohead creep", fake_ytdlp(videos)))
    assert pedidos == []


def test_enrich_no_pide_alias_de_pistas_ya_emparejadas(monkeypatch, fake_ytdlp):
    """Con japones en juego, solo las pistas sin pareja piden su alias."""
    pedidos = []

    async def _alias(ficha):
        pedidos.append(ficha.get("trackId"))
        return {}

    monkeypatch.setattr(matcher, "_aliases_for", _alias)
    ya = {"trackId": 1, "trackName": "Refrain", "artistName": "HAL",
          "trackTimeMillis": 200000}
    suelta = {**DEFAULT, "trackTimeMillis": 200000}
    videos = [{"id": "v1", "title": "HAL - Refrain", "uploader": "HAL", "duration": 200},
              {"id": "v2", "title": "サツキ - メズマライザー", "uploader": "サツキ",
               "duration": 200}]
    asyncio.run(enrich_with_ytdlp([ya, suelta], "q", fake_ytdlp(videos)))
    assert pedidos == [TRACK_ID]


# --------------------------------------------------------------- veredicto
def _track_con_alias() -> Track:
    return Track(source="ytdlp", source_id="v1", title="Mesmerizer",
                 artist="Satsuki",
                 extra={"from_itunes": True,
                        "aliases": {"title": "メズマライザー", "artist": "サツキ"}})


def test_identity_con_alias_no_dice_no_es_lo_que_buscabas():
    """Con ficha de iTunes, el titulo japones del video SI es la cancion."""
    real = "サツキ - メズマライザー"
    ref = identity_best_reference("satsuki mesmerizer", _track_con_alias(), real, real)
    assert ref == "サツキ メズマライザー"
    assert verdict(ref, real)[0] == "match"


def test_identity_con_alias_no_hunde_el_video_en_latin():
    """Los alias no se suman a la referencia: un video en latin con una palabra
    de mas sigue coincidiendo como antes."""
    real = "Satsuki - Mesmerizer (Official Video)"
    ref = identity_best_reference("satsuki mesmerizer", _track_con_alias(), real, real)
    assert ref == identity_reference("satsuki mesmerizer", _track_con_alias(), real)
    assert verdict(ref, real)[0] == "match"


# ------------------------------------------------------------ guardadas
@contextmanager
def _api_con_saved(tmp_path):
    root = tmp_path / "lib"
    root.mkdir()
    set_storage(LocalStorage(root))
    try:
        with TestClient(create_app()) as c:
            yield c
    finally:
        set_storage(None)


def test_link_saved_download_guarda_artist_id(tmp_path):
    """Una descarga nueva completa el artistId que la ficha de iTunes trae."""
    with _api_con_saved(tmp_path) as c:
        sid = song_id("youtube", "dQw4w9WgXcQ")
        rec = {"id": sid, "title": "Mesmerizer", "artist": "Satsuki",
               "source": "youtube", "source_id": "dQw4w9WgXcQ", "itunes": {}}
        assert c.put("/api/saved", json={"songs": [rec]}).status_code == 200
        track = {"source": "ytdlp", "source_id": "dQw4w9WgXcQ",
                 "title": "Mesmerizer", "artist": "Satsuki",
                 "extra": {"webpage_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                           "from_itunes": True, "artist_id": 204264696}}
        assert link_saved_download(track, "Satsuki/Mesmerizer.m4a") is True
        song = c.get("/api/saved").json()["songs"][0]
        assert song["itunes"] == {"artist_id": 204264696}
        assert song["file_key"] == "Satsuki/Mesmerizer.m4a"


def test_link_saved_download_respeta_ids_viejos(tmp_path):
    """Una entrada antigua con ids no se rompe ni se le sobrescriben."""
    with _api_con_saved(tmp_path) as c:
        sid = song_id("youtube", "dQw4w9WgXcQ")
        rec = {"id": sid, "title": "Mesmerizer", "artist": "Satsuki",
               "source": "youtube", "source_id": "dQw4w9WgXcQ",
               "itunes": {"track_id": 7, "artist_id": 1}}
        assert c.put("/api/saved", json={"songs": [rec]}).status_code == 200
        track = {"source": "ytdlp", "source_id": "dQw4w9WgXcQ",
                 "title": "Mesmerizer", "artist": "Satsuki",
                 "extra": {"webpage_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                           "track_id": 9, "artist_id": 2}}
        assert link_saved_download(track, "Satsuki/Mesmerizer.m4a") is True
        song = c.get("/api/saved").json()["songs"][0]
        assert song["itunes"] == {"track_id": 7, "artist_id": 1}
        assert song["file_key"] == "Satsuki/Mesmerizer.m4a"
