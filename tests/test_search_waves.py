"""Busqueda progresiva (search waves): stream NDJSON, match lazy y circuito.

Todo OFFLINE: iTunes, yt-dlp y el reloj del circuito son dobles. Los eventos se
leen igual que en test_album_match_stream.py: una linea JSON por evento.
"""
from __future__ import annotations

import asyncio
import contextlib
import json

import pytest

import backend.app.main as main


def _song(track_id, titulo):
    return {
        "wrapperType": "track", "kind": "song",
        "trackId": track_id, "collectionId": 999,
        "trackName": titulo, "artistName": "Linkin Park",
        "collectionName": "Meteora", "trackTimeMillis": 200_000,
        "artworkUrl100": "http://x/100x100bb.jpg",
        "releaseDate": "2003-03-25T07:00:00Z",
        "previewUrl": f"http://p/{track_id}",
        "trackViewUrl": f"http://t/{track_id}",
    }


def _video(clave, titulo):
    return {
        "video": {"id": f"v{clave}", "title": titulo,
                  "uploader": "Linkin Park"},
        "score": 0.9, "why": "canal",
        "webpage_url": f"https://www.youtube.com/watch?v=v{clave}",
    }


def _miss():
    return {"video": None, "score": 0.0, "why": "sin-señal"}


class _Youtube:
    """Fuente yt-dlp falsa, con busqueda grupal y contador de puntuales."""

    def __init__(self, *, disponible=True, error=None):
        self.disponible = disponible
        self.error = error
        self.llamadas = []

    def available(self):
        return self.disponible

    async def search_candidates(self, q, limit=40):
        self.llamadas.append((q, limit))
        if self.error:
            raise self.error
        return []


async def _sin_estantes(self, q, limit=8):
    return []


def _instalar(monkeypatch, canciones, enriquecer, *, yt=None,
              artistas=_sin_estantes, albumes=_sin_estantes):
    """Instala iTunes, yt-dlp y, si se da, el matcher falso para una corrida.

    Los estantes (artistas y albumes) van vacios salvo que el test los pida:
    el stream los busca siempre y no debe salir a la red."""
    yt = yt or _Youtube()

    async def _raw(self, q, limit=20):
        return list(canciones)

    monkeypatch.setattr("backend.app.sources.ITunesSource._raw_search", _raw)
    monkeypatch.setattr("backend.app.sources.ITunesSource.search_artists", artistas)
    monkeypatch.setattr("backend.app.sources.ITunesSource.search_albums", albumes)
    monkeypatch.setitem(main.BY_NAME, "ytdlp", yt)
    monkeypatch.setattr(main, "_register_ytdlp", lambda: None)
    if enriquecer is not None:
        monkeypatch.setattr("backend.app.matcher.enrich_with_ytdlp", enriquecer)
    return yt


def _stream(cliente, url):
    with cliente.stream("GET", url) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("application/x-ndjson")
        return [json.loads(linea) for linea in r.iter_lines() if linea.strip()]


# ------------------------------------------------------------------ stream
def test_stream_catalogo_primero_done_ultimo_y_estados(cliente, monkeypatch):
    """Catalogo pendiente en orden iTunes, grupos full, puntuales y lazy."""
    canciones = [_song(i, f"C{i}") for i in range(1, 13)]
    retardos = {str(i): 0.001 * (11 - i) for i in range(2, 11)}
    puntuales = []

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        if len(tracks) > 1:
            # El grupo solo empareja C1 y C11 (esta ultima, fuera del top 10).
            return {str(t["trackId"]): (
                _video(str(t["trackId"]), t["trackName"])
                if t["trackId"] in (1, 11) else _miss()) for t in tracks}
        puntuales.append(query)
        clave = str(tracks[0]["trackId"])
        await asyncio.sleep(retardos[clave])
        if clave in ("2", "3"):
            return {clave: _video(clave, tracks[0]["trackName"])}
        return {clave: _miss()}

    yt = _instalar(monkeypatch, canciones, _enrich)
    eventos = _stream(cliente, "/api/search?q=linkin&mode=matched&stream=1")

    tipos = [e["type"] for e in eventos]
    assert tipos[0] == "catalog" and tipos[-1] == "done"
    assert all(t == "tracks" for t in tipos[1:-1])

    catalogo = eventos[0]
    assert catalogo["query"] == "linkin"
    assert catalogo["mode"] == "matched" and catalogo["ytdlp"] is True
    assert catalogo["count"] == 12 and "full" not in catalogo
    assert [t["title"] for t in catalogo["results"]] == [f"C{i}" for i in range(1, 13)]
    assert all(t["extra"]["match_state"] == "pending" for t in catalogo["results"])
    assert all(t["extra"]["has_full"] is None for t in catalogo["results"])

    lotes = [e["tracks"] for e in eventos if e["type"] == "tracks"]
    por_titulo = {t["title"]: t for lote in lotes for t in lote}
    assert por_titulo["C1"]["extra"]["match_state"] == "full"
    assert por_titulo["C1"]["extra"]["has_full"] is True
    assert por_titulo["C1"]["extra"]["webpage_url"].startswith("https://www.youtube.com/")
    # C12 nunca se busca suelta: queda lazy para cuando se haga visible.
    assert por_titulo["C12"]["extra"]["match_state"] == "lazy"
    assert por_titulo["C12"]["extra"]["has_full"] is None
    # Un acierto del grupo fuera del top 10 va directo a full.
    assert por_titulo["C11"]["extra"]["match_state"] == "full"
    assert por_titulo["C2"]["extra"]["has_full"] is True
    assert por_titulo["C4"]["extra"]["match_state"] == "none"
    assert por_titulo["C4"]["extra"]["has_full"] is False

    done = eventos[-1]
    assert done == {"type": "done", "full": 4, "count": 12}

    # Solo se buscan sueltas las 9 del top 10 que el grupo no emparejo.
    assert len(puntuales) == 9
    assert any(c[1] == 40 for c in yt.llamadas)  # la grupal sigue siendo de 40


def test_stream_sin_youtube_es_none_y_done(cliente, monkeypatch):
    canciones = [_song(1, "C1"), _song(2, "C2")]

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        raise AssertionError("yt-dlp apagado: no debe buscar")

    _instalar(monkeypatch, canciones, _enrich,
              yt=_Youtube(disponible=False))
    eventos = _stream(cliente, "/api/search?q=x&mode=matched&stream=1")
    assert [e["type"] for e in eventos] == ["catalog", "done"]
    assert all(t["extra"]["match_state"] == "none"
               for t in eventos[0]["results"])
    assert all(t["extra"]["has_full"] is False
               for t in eventos[0]["results"])
    assert eventos[-1] == {"type": "done", "full": 0, "count": 2}


def test_stream_orden_de_las_puntuales_es_de_finalizacion(cliente, monkeypatch):
    canciones = [_song(i, f"C{i}") for i in range(1, 4)]
    retardos = {"1": 0.03, "2": 0.01, "3": 0.02}

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        if len(tracks) > 1:
            return {}
        clave = str(tracks[0]["trackId"])
        await asyncio.sleep(retardos[clave])
        return {clave: _video(clave, tracks[0]["trackName"])}

    _instalar(monkeypatch, canciones, _enrich)
    eventos = _stream(cliente, "/api/search?q=x&mode=matched&stream=1")
    lotes = [e["tracks"] for e in eventos if e["type"] == "tracks"]
    assert [t["title"] for lote in lotes for t in lote] == ["C2", "C3", "C1"]


def test_cerrar_el_generador_cancela_las_busquedas_pendientes(monkeypatch):
    empezo = asyncio.Event()
    canceladas = []

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        if len(tracks) > 1:
            return {}
        empezo.set()
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            canceladas.append(str(tracks[0]["trackId"]))
            raise
        return {}

    _instalar(monkeypatch, [_song(1, "C1"), _song(2, "C2")], _enrich)

    async def correr():
        gen = main._search_matched_eventos("x", 10, stream=True)
        assert (await gen.__anext__())[0] == "catalog"
        paso = asyncio.create_task(gen.__anext__())
        await asyncio.wait_for(empezo.wait(), 1)
        paso.cancel()
        with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration):
            await paso
        with contextlib.suppress(RuntimeError):
            await gen.aclose()
        return canceladas

    assert sorted(asyncio.run(correr())) == ["1", "2"]


def test_stream_puntuales_comparten_limite_de_seis(cliente, monkeypatch):
    canciones = [_song(i, f"C{i}") for i in range(1, 11)]
    activos = {"n": 0, "pico": 0}

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        if len(tracks) > 1:
            return {}
        activos["n"] += 1
        activos["pico"] = max(activos["pico"], activos["n"])
        await asyncio.sleep(0.01)
        activos["n"] -= 1
        return {}

    _instalar(monkeypatch, canciones, _enrich)
    eventos = _stream(cliente, "/api/search?q=x&mode=matched&stream=1")
    assert eventos[-1]["type"] == "done"
    assert activos["pico"] == main._SEARCH_SINGLE_SEMAPHORE == 6


def test_stream_fallo_de_itunes_devuelve_502_antes_de_abrir(cliente, monkeypatch):
    import httpx

    async def _roto(self, q, limit=20):
        raise httpx.ConnectError("sin red")

    monkeypatch.setattr("backend.app.sources.ITunesSource._raw_search", _roto)
    monkeypatch.setattr("backend.app.sources.ITunesSource.search_artists", _sin_estantes)
    monkeypatch.setattr("backend.app.sources.ITunesSource.search_albums", _sin_estantes)
    r = cliente.get("/api/search?q=x&mode=matched&stream=1")
    assert r.status_code == 502
    assert "application/json" in r.headers["content-type"]


# ---------------------------------------------------------------- estantes
_ARTISTA = {"artistId": 777, "artistName": "Linkin Park",
            "primaryGenreName": "Rock"}
_ALBUM = {"collectionId": 999, "artistId": 777, "collectionName": "Meteora",
          "artistName": "Linkin Park", "releaseDate": "2003-03-25T07:00:00Z",
          "trackCount": 12, "artworkUrl100": "http://x/100x100bb.jpg",
          "collectionExplicitness": "notExplicit"}


def _sin_match(tracks, query, ysrc, limit=40, videos=None):
    async def _nada():
        return {}
    return _nada()


def test_stream_estantes_a_tiempo_van_en_el_catalogo(cliente, monkeypatch):
    """Artistas y albumes listos a tiempo pintan con las canciones."""
    pedidos = {}

    async def _artistas(self, q, limit=5):
        pedidos["artists"] = (q, limit)
        return [_ARTISTA]

    async def _albumes(self, q, limit=8):
        pedidos["albums"] = (q, limit)
        return [_ALBUM]

    _instalar(monkeypatch, [_song(1, "C1")], _sin_match,
              artistas=_artistas, albumes=_albumes)
    eventos = _stream(cliente, "/api/search?q=linkin&mode=matched&stream=1")

    assert "shelves" not in [e["type"] for e in eventos]
    catalogo = eventos[0]
    assert catalogo["type"] == "catalog"
    # La misma forma que /api/artists/search y /api/albums/search.
    assert catalogo["artists"] == [{"id": 777, "name": "Linkin Park", "genre": "Rock"}]
    assert catalogo["albums"] == [main._album_dict(_ALBUM)]
    assert pedidos == {"artists": ("linkin", 3), "albums": ("linkin", 8)}
    assert eventos[-1]["type"] == "done"


def test_stream_estantes_lentos_salen_en_su_evento_entre_lotes(cliente, monkeypatch):
    monkeypatch.setattr(main, "_SHELVES_WAIT_S", 0.01)

    async def _artistas(self, q, limit=5):
        await asyncio.sleep(0.1)
        return [_ARTISTA]

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        if len(tracks) > 1:
            return {}
        await asyncio.sleep(0.4)
        return {str(tracks[0]["trackId"]): _miss()}

    _instalar(monkeypatch, [_song(1, "C1"), _song(2, "C2")], _enrich,
              artistas=_artistas)
    eventos = _stream(cliente, "/api/search?q=x&mode=matched&stream=1")

    # Los estantes no esperan a las puntuales: salen en cuanto terminan.
    assert [e["type"] for e in eventos] == [
        "catalog", "shelves", "tracks", "tracks", "done"]
    assert "artists" not in eventos[0] and "albums" not in eventos[0]
    assert eventos[1] == {"type": "shelves", "albums": [], "artists": [
        {"id": 777, "name": "Linkin Park", "genre": "Rock"}]}


def test_stream_estantes_que_fallan_dan_listas_vacias(cliente, monkeypatch):
    import httpx

    async def _roto(self, q, limit=8):
        raise httpx.ConnectError("sin red")

    async def _peor(self, q, limit=8):
        raise RuntimeError("iTunes devolvio basura")

    _instalar(monkeypatch, [_song(1, "C1")], _sin_match,
              artistas=_roto, albumes=_peor)
    eventos = _stream(cliente, "/api/search?q=x&mode=matched&stream=1")

    assert eventos[0]["artists"] == [] and eventos[0]["albums"] == []
    assert [t["title"] for t in eventos[0]["results"]] == ["C1"]
    assert eventos[-1]["type"] == "done"


def test_stream_estantes_colgados_no_retienen_el_done(cliente, monkeypatch):
    monkeypatch.setattr(main, "_SHELVES_WAIT_S", 0.01)
    monkeypatch.setattr(main, "_SHELVES_MAX_S", 0.05)

    async def _colgado(self, q, limit=5):
        await asyncio.sleep(10)
        return [_ARTISTA]

    _instalar(monkeypatch, [_song(1, "C1")], _sin_match, artistas=_colgado,
              yt=_Youtube(disponible=False))
    eventos = _stream(cliente, "/api/search?q=x&mode=matched&stream=1")

    # El frontend siempre recibe sus estantes (vacios) antes del final.
    assert [e["type"] for e in eventos] == ["catalog", "shelves", "done"]
    assert eventos[1] == {"type": "shelves", "artists": [], "albums": []}


# ------------------------------------------------------------------- JSON
def test_json_sigue_igual_y_agrega_match_state(cliente, monkeypatch):
    canciones = [_song(1, "C1"), _song(2, "C2")]

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        assert len(tracks) == 2  # el JSON no hace busquedas sueltas
        return {str(t["trackId"]): (
            _video("1", "C1") if t["trackId"] == 1 else _miss())
            for t in tracks}

    async def _prohibido(self, q, limit=8):
        raise AssertionError("el JSON no busca estantes")

    yt = _instalar(monkeypatch, canciones, _enrich,
                   artistas=_prohibido, albumes=_prohibido)
    r = cliente.get("/api/search?q=x&mode=matched")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"query", "mode", "ytdlp", "catalog",
                         "count", "full", "results"}
    assert [t["title"] for t in body["results"]] == ["C1", "C2"]  # full-first
    assert body["full"] == 1 and body["count"] == 2
    assert [t["extra"]["match_state"] for t in body["results"]] == ["full", "none"]
    assert body["results"][0]["extra"]["has_full"] is True
    assert body["results"][1]["extra"]["has_full"] is False
    assert len(yt.llamadas) == 1  # solo la grupal


# --------------------------------------------------------------- ruta lazy
def _preparar_lazy(monkeypatch, cancion, *, enriquecer=None, lookup=None):
    """Cache cruda lista y iTunes desactivado: fuerza el origen de la ficha."""
    main._track_raw_put([cancion])
    monkeypatch.setitem(main.BY_NAME, "ytdlp", _Youtube())
    monkeypatch.setattr(main, "_register_ytdlp", lambda: None)

    async def _lookup(self, track_id):
        if lookup is None:
            raise AssertionError("no debia ir a iTunes")
        return lookup

    monkeypatch.setattr("backend.app.sources.ITunesSource.lookup_track", _lookup)
    if enriquecer is not None:
        monkeypatch.setattr("backend.app.matcher.enrich_with_ytdlp", enriquecer)


def test_lazy_desde_el_mapa_crudo(cliente, monkeypatch):
    cancion = _song(1, "C1")
    vistos = []

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        vistos.append(query)
        return {"1": _video("1", "C1")}

    _preparar_lazy(monkeypatch, cancion, enriquecer=_enrich)
    r = cliente.get("/api/search/match/1")
    assert r.status_code == 200
    track = r.json()["track"]
    assert track["title"] == "C1"
    assert track["extra"]["match_state"] == "full"
    assert track["extra"]["has_full"] is True
    assert vistos == ["Linkin Park C1"]


def test_lazy_cae_a_lookup_de_itunes(cliente, monkeypatch):
    async def _lookup(self, track_id):
        assert track_id == "7"
        return _song(7, "C7")

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        return {}

    _preparar_lazy(monkeypatch, _song(99, "Otra"),
                   enriquecer=_enrich, lookup=_song(7, "C7"))
    # Se limpia el mapa para que el unico origen sea el lookup.
    main._TRACK_RAW_CACHE.clear()
    r = cliente.get("/api/search/match/7")
    assert r.status_code == 200
    assert r.json()["track"]["title"] == "C7"
    assert r.json()["track"]["extra"]["match_state"] == "none"


def test_lazy_id_no_digito_da_422(cliente):
    assert cliente.get("/api/search/match/abc").status_code == 422


def test_lazy_cache_hit_no_busca(cliente, monkeypatch):
    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        raise AssertionError("cache hit: no debe buscar")

    _preparar_lazy(monkeypatch, _song(1, "C1"), enriquecer=_enrich)
    main._track_match_cache_put("1", _video("1", "C1"))
    r = cliente.get("/api/search/match/1")
    assert r.status_code == 200
    assert r.json()["track"]["extra"]["match_state"] == "full"


def test_lazy_respeta_el_ttl_de_diez_minutos_del_fallo(cliente, monkeypatch):
    reloj = {"t": 1000.0}
    monkeypatch.setattr(main, "_breaker_clock", lambda: reloj["t"])
    llamadas = []

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        llamadas.append(1)
        return {}

    _preparar_lazy(monkeypatch, _song(1, "C1"), enriquecer=_enrich)
    main._track_match_cache_put("1", {})  # fallo cacheado
    assert cliente.get("/api/search/match/1").status_code == 200
    assert llamadas == []

    reloj["t"] += 9 * 60
    assert cliente.get("/api/search/match/1").status_code == 200
    assert llamadas == []

    reloj["t"] += 2 * 60  # ya vencio el fallo
    assert cliente.get("/api/search/match/1").status_code == 200
    assert len(llamadas) == 1


def test_lazy_priority_no_usa_el_semaphore(cliente, monkeypatch):
    """`priority=1` llama a _buscar_pista_suelta con priority=True."""
    vistos = []

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        return {}

    _preparar_lazy(monkeypatch, _song(1, "C1"), enriquecer=_enrich)

    original = main._buscar_pista_suelta

    async def _espia(raw, ysrc, *, sem=None, artista="", priority=False):
        vistos.append(priority)
        return await original(raw, ysrc, sem=sem, artista=artista,
                              priority=priority)

    monkeypatch.setattr(main, "_buscar_pista_suelta", _espia)
    assert cliente.get("/api/search/match/1?priority=1").status_code == 200
    assert vistos == [True]


# --------------------------------------------------------------- circuito
def test_bot_wall_abre_el_circuito_y_el_lazy_devuelve_503(cliente, monkeypatch):
    reloj = {"t": 1000.0}
    monkeypatch.setattr(main, "_breaker_clock", lambda: reloj["t"])
    cancion = _song(1, "C1")
    yt = _Youtube(error=RuntimeError("Sign in to confirm you're not a bot"))
    monkeypatch.setitem(main.BY_NAME, "ytdlp", yt)
    monkeypatch.setattr(main, "_register_ytdlp", lambda: None)
    main._track_raw_put([cancion])

    # El matcher real llama a search_candidates: ahi se detecta el muro.
    primera = cliente.get("/api/search/match/1")
    assert primera.status_code == 200
    assert primera.json()["track"]["extra"]["match_state"] == "none"
    assert main._YT_BREAKER_OPENED_AT == 1000.0

    segunda = cliente.get("/api/search/match/1")
    assert segunda.status_code == 503
    assert segunda.json()["code"] == "youtube_busy"
    assert len(yt.llamadas) == 1  # no se inicio otra busqueda

    reloj["t"] += 5 * 60
    assert main._breaker_abierto() is False  # se cerro solo
    assert main._YT_BREAKER_OPENED_AT is None


def test_rate_limit_de_429_tambien_abre_el_circuito(monkeypatch):
    main._breaker_reset()
    yt = _Youtube(error=RuntimeError("HTTP 429: too many requests"))

    async def correr():
        with pytest.raises(RuntimeError):
            await main._YtConCircuito(yt).search_candidates("x")
        return main._breaker_abierto()

    assert asyncio.run(correr()) is True
    main._breaker_reset()


def test_stream_con_circuito_abierto_deja_pending_en_none(cliente, monkeypatch):
    """Un 429 puntual abre el circuito; las demas filas pasan a none."""
    canciones = [_song(i, f"C{i}") for i in range(1, 4)]

    class _YtConMuro:
        def available(self):
            return True

        async def search_candidates(self, q, limit=40):
            self.llamadas.append((q, limit))
            if "C1" in q:
                raise RuntimeError("HTTP 429: try again later")
            return []

    yt = _YtConMuro()
    yt.llamadas = []
    # Sin matcher falso: la busqueda real pasa por el proxy del circuito.
    _instalar(monkeypatch, canciones, None, yt=yt)
    eventos = _stream(cliente, "/api/search?q=x&mode=matched&stream=1")
    assert eventos[-1] == {"type": "done", "full": 0, "count": 3}
    por_titulo = {t["title"]: t for e in eventos if e["type"] == "tracks"
                  for t in e["tracks"]}
    assert all(t["extra"]["match_state"] == "none"
               for t in por_titulo.values())
    # El muro se abrio en C1: C2 y C3 no llegaron a YouTube.
    assert len(yt.llamadas) == 2
    assert any("C1" in q and limit == main._ALBUM_TRACK_LIMIT
               for q, limit in yt.llamadas)


# ------------------------------------------------------- arreglos de revision
def test_un_error_de_youtube_no_se_cachea_como_fallo(cliente, monkeypatch):
    """La busqueda que se cae no es "no hay video": no queda diez minutos."""
    cancion = _song(1, "C1")
    yt = _Youtube(error=RuntimeError("connection reset by peer"))
    monkeypatch.setitem(main.BY_NAME, "ytdlp", yt)
    monkeypatch.setattr(main, "_register_ytdlp", lambda: None)
    main._track_raw_put([cancion])

    r = cliente.get("/api/search/match/1")
    assert r.json()["track"]["extra"]["match_state"] == "none"
    assert main._track_match_cache_get("1") is None
    cliente.get("/api/search/match/1")
    assert len(yt.llamadas) == 2  # se reintenta, no sale de la cache


def test_lazy_con_circuito_abierto_sirve_lo_cacheado(cliente, monkeypatch):
    cancion = _song(1, "C1")
    _instalar(monkeypatch, [cancion], None)
    main._track_raw_put([cancion])
    main._track_match_cache_put("1", _video("1", "C1"))
    main._breaker_abrir()

    r = cliente.get("/api/search/match/1")
    assert r.status_code == 200
    assert r.json()["track"]["extra"]["match_state"] == "full"


def test_lazy_y_stream_comparten_el_mismo_limite(monkeypatch):
    """La ruta lazy usa el semaforo del loop, el mismo que el stream."""
    async def correr():
        a = main._search_single_sem()
        b = main._search_single_sem()
        assert a is b
        assert a._value == main._SEARCH_SINGLE_SEMAPHORE
        usados = []

        async def _suelta(raw, ysrc, *, sem=None, artista="", priority=False):
            usados.append(sem)
            return {}

        monkeypatch.setattr(main, "_buscar_pista_suelta", _suelta)
        monkeypatch.setitem(main.BY_NAME, "ytdlp", _Youtube())
        monkeypatch.setattr(main, "_register_ytdlp", lambda: None)
        main._track_raw_put([_song(7, "C7")])

        class _Req:
            path_params = {"track_id": "7"}
            query_params = {}

        await main.search_match(_Req())
        assert usados == [a]

    asyncio.run(correr())


def test_stream_lo_cacheado_sale_full_en_el_catalogo(cliente, monkeypatch):
    """Una busqueda repetida no espera a YouTube para lo que ya se sabe, y el
    grupo solo reparte videos entre las que faltan."""
    canciones = [_song(i, f"C{i}") for i in range(1, 4)]
    main._track_match_cache_put("2", _video("2", "C2"))
    grupos = []

    async def _enrich(tracks, query, ysrc, limit=40, videos=None):
        if len(tracks) > 1:
            grupos.append([t["trackId"] for t in tracks])
            return {str(t["trackId"]): _miss() for t in tracks}
        return {str(tracks[0]["trackId"]): _miss()}

    _instalar(monkeypatch, canciones, _enrich)
    eventos = _stream(cliente, "/api/search?q=linkin&mode=matched&stream=1")

    estados = {t["source_id"]: t["extra"]["match_state"]
               for t in eventos[0]["results"]}
    assert estados == {"1": "pending", "2": "full", "3": "pending"}
    assert grupos == [[1, 3]]
