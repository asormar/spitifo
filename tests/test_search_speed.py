"""Modo Musica: iTunes y YouTube a la vez, e instancias de yt-dlp reusadas.

Todo OFFLINE: iTunes, la fuente de yt-dlp y YoutubeDL son dobles.
"""
from __future__ import annotations

import asyncio
import queue

import pytest

import backend.app.main as main
from backend.app import ytdlp_source


class _YtFalso:
    name = "ytdlp"

    def __init__(self, empezo: asyncio.Event | None = None):
        self.empezo = empezo
        self.cancelada = False
        self.llamadas = 0

    def available(self):
        return True

    async def search_candidates(self, q, limit=20):
        self.llamadas += 1
        if self.empezo:
            self.empezo.set()
        try:
            await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            self.cancelada = True
            raise
        return []


@pytest.fixture
def con_youtube(monkeypatch):
    def poner(falso):
        monkeypatch.setitem(main.BY_NAME, "ytdlp", falso)
        monkeypatch.setattr(main, "_register_ytdlp", lambda: None)
        return falso
    return poner


def test_youtube_espera_a_saber_que_falta_antes_de_arrancar(monkeypatch, con_youtube):
    """YouTube es lo caro: recien arranca despues de ver el catalogo de
    iTunes y que de eso no este ya en la cache de matches (ver
    `test_sin_resultados_de_itunes_no_toca_youtube` y
    `test_catalogo_totalmente_cacheado_no_toca_youtube` para los casos donde
    ni siquiera arranca)."""
    async def correr():
        yt = _YtFalso()
        con_youtube(yt)

        async def itunes(self, q, limit=20):
            assert yt.llamadas == 0, "YouTube no debe arrancar antes que iTunes"
            return [{"trackId": 1, "trackName": "Dreams", "artistName": "Fleetwood Mac"}]

        monkeypatch.setattr("backend.app.sources.ITunesSource._raw_search", itunes)
        return await main._search_matched("fleetwood mac dreams", 10)

    data = asyncio.run(correr())
    assert data["count"] == 1


def test_sin_resultados_de_itunes_no_toca_youtube(monkeypatch, con_youtube):
    """Catalogo vacio: ni se decide si falta algo, directo no hay pistas."""
    yt = con_youtube(_YtFalso())

    async def itunes(self, q, limit=20):
        await asyncio.sleep(0)
        return []

    monkeypatch.setattr("backend.app.sources.ITunesSource._raw_search", itunes)

    async def correr():
        return await main._search_matched("nada", 10)

    assert asyncio.run(correr())["count"] == 0
    assert yt.llamadas == 0


def test_catalogo_totalmente_cacheado_no_toca_youtube(monkeypatch, con_youtube):
    """Finding #9 (network-caching): una busqueda cuyas pistas ya tienen
    match cacheado no dispara ningun `search_candidates`."""
    yt = con_youtube(_YtFalso())

    async def itunes(self, q, limit=20):
        return [{"trackId": 1, "trackName": "Dreams", "artistName": "Fleetwood Mac"}]

    monkeypatch.setattr("backend.app.sources.ITunesSource._raw_search", itunes)
    main._track_match_cache_put("1", {
        "video": {"id": "v1", "title": "Dreams", "uploader": "Fleetwood Mac"},
        "score": 0.9, "why": "canal",
        "webpage_url": "https://www.youtube.com/watch?v=v1",
    })

    data = asyncio.run(main._search_matched("fleetwood mac dreams", 10))
    assert data["full"] == 1
    assert yt.llamadas == 0


class _YdlFalso:
    def __init__(self, falla=False):
        self.falla = falla
        self.cerrado = False
        self.busquedas = 0

    def extract_info(self, url, download=False):
        self.busquedas += 1
        if self.falla:
            raise RuntimeError("red")
        return {"entries": [{"id": "abc", "title": "x"}]}

    def close(self):
        self.cerrado = True


def test_la_busqueda_reusa_la_instancia_del_pool(monkeypatch):
    pool = queue.Queue(maxsize=3)
    ydl = _YdlFalso()
    pool.put(ydl)
    monkeypatch.setattr(ytdlp_source, "_SEARCH_POOL", pool)
    src = ytdlp_source.YtDlpSource()

    for _ in range(2):
        assert asyncio.run(src.search_candidates("q", limit=5)) == [{"id": "abc", "title": "x"}]
    assert ydl.busquedas == 2
    assert pool.get_nowait() is ydl  # volvio al pool


def test_una_instancia_que_falla_no_vuelve_al_pool(monkeypatch):
    pool = queue.Queue(maxsize=3)
    ydl = _YdlFalso(falla=True)
    pool.put(ydl)
    monkeypatch.setattr(ytdlp_source, "_SEARCH_POOL", pool)
    src = ytdlp_source.YtDlpSource()

    with pytest.raises(RuntimeError):
        asyncio.run(src.search_candidates("q"))
    assert ydl.cerrado
    assert pool.empty()
