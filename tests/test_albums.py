"""Albumes: campos de pista, busqueda, detalle, match y tags de orden.

Todo OFFLINE: iTunes y yt-dlp se reemplazan por dobles, como en test_matcher.py
y test_api_contrato.py. Los archivos de audio salen de las fixtures de ffmpeg
de conftest.py (no de la red).
"""
from __future__ import annotations

import asyncio
import json
import subprocess

import pytest

from backend.app.models import Track


def _song(track_id, titulo, *, disco=1, pista=1):
    """Un item de /lookup con los campos de album que iTunes ya devuelve."""
    return {
        "wrapperType": "track", "kind": "song",
        "trackId": track_id, "collectionId": 999,
        "trackName": titulo, "artistName": "Linkin Park",
        "collectionName": "Meteora", "trackTimeMillis": 200_000,
        "artworkUrl100": "http://x/100x100bb.jpg",
        "releaseDate": "2003-03-25T07:00:00Z",
        "collectionExplicitness": "notExplicit",
        "trackNumber": pista, "discNumber": disco,
        "trackCount": 12, "discCount": 2,
        "previewUrl": "http://p", "trackViewUrl": "http://t",
    }


def _collection(**cambios):
    """El wrapper de collection que iTunes pone antes que las canciones."""
    base = {
        "wrapperType": "collection", "collectionId": 999,
        "collectionName": "Meteora", "artistName": "Linkin Park",
        "releaseDate": "2003-03-25T07:00:00Z", "trackCount": 12,
        "artworkUrl100": "http://x/100x100bb.jpg",
        "collectionExplicitness": "notExplicit",
    }
    base.update(cambios)
    return base


async def _enrich_vacio(tracks, query, ysrc, limit=40):
    return {}


# -------------------------------------------------- campos en _search_matched
def test_search_matched_conserva_los_campos_de_album(monkeypatch):
    """La ficha cruda de iTunes ya trae el orden; no se puede perder en /search."""
    import backend.app.main as main

    raw = _song(111, "Numb", disco=1, pista=4)
    raw["primaryGenreName"] = "Rock"
    sin_campos = {"trackId": 112, "trackName": "Otro", "artistName": "X"}

    async def _raw(self, q, limit=20):
        return [raw, sin_campos]

    monkeypatch.setattr("backend.app.sources.ITunesSource._raw_search", _raw)
    monkeypatch.setattr("backend.app.matcher.enrich_with_ytdlp", _enrich_vacio)

    data = asyncio.run(main._search_matched("numb", 10))
    completo = data["results"][0]["extra"]
    assert completo["collection_id"] == 999
    assert completo["track_number"] == 4
    assert completo["disc_number"] == 1
    assert completo["track_count"] == 12
    assert completo["disc_count"] == 2

    incompleto = data["results"][1]["extra"]
    for clave in ("collection_id", "track_number", "disc_number",
                  "track_count", "disc_count"):
        assert incompleto[clave] is None


# -------------------------------------------------- catalog: none / weak / match
def _matched(monkeypatch, q, crudos):
    """Corre _search_matched sin red: iTunes y yt-dlp son dobles."""
    import backend.app.main as main

    async def _raw(self, q, limit=20):
        return crudos

    monkeypatch.setattr("backend.app.sources.ITunesSource._raw_search", _raw)
    monkeypatch.setattr("backend.app.matcher.enrich_with_ytdlp", _enrich_vacio)
    return asyncio.run(main._search_matched(q, 10))


def test_search_matched_catalog_none_sin_items(monkeypatch):
    data = _matched(monkeypatch, "rosalia despecha", [])
    assert data["catalog"] == "none"
    assert data["count"] == 0
    assert data["results"] == []


def test_search_matched_catalog_match_ignora_acentos_y_mayusculas(monkeypatch):
    crudo = _song(1, "DESPECHÁ")
    crudo["artistName"] = "ROSALÍA"
    data = _matched(monkeypatch, "rosalia despecha", [crudo])
    assert data["catalog"] == "match"
    assert data["count"] == 1


def test_search_matched_catalog_weak_cuando_solo_cubre_el_titulo(monkeypatch):
    """El artista no aparece: iTunes trae canciones que no son lo pedido."""
    crudo = _song(2, "Despechá")
    crudo["artistName"] = "Otro Artista"
    data = _matched(monkeypatch, "rosalia despecha", [crudo])
    assert data["catalog"] == "weak"
    # weak NO corta: los resultados se siguen mostrando como hoy.
    assert data["count"] == 1


def test_search_matched_catalog_weak_solo_artista(monkeypatch):
    """La otra mitad: artista si, cancion no."""
    crudo = _song(3, "Otra canción")
    crudo["artistName"] = "Rosalía"
    data = _matched(monkeypatch, "rosalia despecha", [crudo])
    assert data["catalog"] == "weak"


def test_search_matched_catalog_match_sin_palabras_utiles(monkeypatch):
    """Consultas de una letra no discriminan: cuentan como match."""
    data = _matched(monkeypatch, "a x", [_song(4, "Cualquiera")])
    assert data["catalog"] == "match"


# ---------------------------------------------------------- /api/albums/search
def test_albums_search_forma(cliente, monkeypatch):
    from backend.app.sources import ITunesSource

    album = {
        "wrapperType": "collection", "collectionId": 999, "artistId": 777,
        "collectionName": "Meteora", "artistName": "Linkin Park",
        "releaseDate": "2003-03-25T07:00:00Z", "trackCount": 12,
        "artworkUrl100": "http://x/100x100bb.jpg",
        "collectionExplicitness": "explicit",
    }
    vistos = {}

    async def _search(self, q, limit=8):
        vistos.update(q=q, limit=limit)
        return [album]

    monkeypatch.setattr(ITunesSource, "search_albums", _search)
    r = cliente.get("/api/albums/search", params={"q": "meteora"})
    assert r.status_code == 200
    body = r.json()
    assert body["query"] == "meteora"
    assert vistos == {"q": "meteora", "limit": 8}
    assert body["albums"] == [{
        "id": 999, "artist_id": 777, "title": "Meteora",
        "artist": "Linkin Park",
        "year": "2003", "track_count": 12,
        "artwork_url": "http://x/300x300bb.jpg", "explicit": True,
    }]


def test_albums_search_fallo_da_lista_vacia(cliente, monkeypatch):
    from backend.app.sources import ITunesSource

    async def _roto(self, q, limit=8):
        raise RuntimeError("iTunes no contesta")

    monkeypatch.setattr(ITunesSource, "search_albums", _roto)
    r = cliente.get("/api/albums/search", params={"q": "x"})
    assert r.status_code == 200
    assert r.json() == {"query": "x", "albums": []}


# ------------------------------------------------------------- /api/album/{id}
def test_album_detalle_ordena_por_disco_y_pista(cliente, monkeypatch):
    from backend.app.sources import ITunesSource

    canciones = [
        _song(2, "Dos", disco=2, pista=1),
        _song(1, "Uno", disco=1, pista=2),
        _song(0, "Intro", disco=1, pista=1),
    ]

    async def _lookup(self, album_id):
        assert str(album_id) == "999"
        return None, list(canciones)

    monkeypatch.setattr(ITunesSource, "lookup", _lookup)
    r = cliente.get("/api/album/999")
    assert r.status_code == 200
    body = r.json()
    assert body["album"]["id"] == 999
    assert body["album"]["title"] == "Meteora"
    assert [t["title"] for t in body["tracks"]] == ["Intro", "Uno", "Dos"]
    extra = body["tracks"][0]["extra"]
    # recien abierto: nadie busco video todavia
    assert extra["has_full"] is None
    assert extra["collection_id"] == 999
    assert extra["track_number"] == 1
    assert extra["disc_number"] == 1


def test_album_detalle_inexistente_da_404(cliente, monkeypatch):
    from backend.app.sources import ITunesSource

    async def _vacio(self, album_id):
        return None, []

    monkeypatch.setattr(ITunesSource, "lookup", _vacio)
    r = cliente.get("/api/album/404")
    assert r.status_code == 404
    assert "album" in r.json()["detail"].lower()


def test_lookup_separa_la_coleccion_de_las_canciones():
    import httpx

    from backend.app.sources import ITunesSource

    coleccion = _collection()
    cancion = _song(1, "Uno")
    sin_kind = {"wrapperType": "other", "collectionId": 1}

    def handler(request):
        return httpx.Response(200, json={"results": [coleccion, cancion,
                                                      sin_kind]})

    fuente = ITunesSource()
    fuente._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        col, canciones = asyncio.run(fuente.lookup("999"))
    finally:
        asyncio.run(fuente.aclose())
    assert col == coleccion
    assert canciones == [cancion]


def test_album_detalle_usa_el_wrapper_para_el_artista(cliente, monkeypatch):
    from backend.app.sources import ITunesSource

    coleccion = _collection(collectionName="Recopilatorio",
                            artistName="Varios artistas")
    cancion = _song(1, "Uno")
    cancion["artistName"] = "Solista Uno"

    async def _lookup(self, album_id):
        return coleccion, [cancion]

    monkeypatch.setattr(ITunesSource, "lookup", _lookup)
    r = cliente.get("/api/album/999")
    assert r.status_code == 200
    assert r.json()["album"]["artist"] == "Varios artistas"
    # La pista conserva el suyo: el wrapper solo manda en la cabecera.
    assert r.json()["tracks"][0]["artist"] == "Solista Uno"


def test_album_detalle_sin_wrapper_cae_a_la_primera_pista(cliente, monkeypatch):
    from backend.app.sources import ITunesSource

    cancion = _song(1, "Uno")

    async def _lookup(self, album_id):
        return None, [cancion]

    monkeypatch.setattr(ITunesSource, "lookup", _lookup)
    r = cliente.get("/api/album/999")
    assert r.status_code == 200
    assert r.json()["album"]["artist"] == "Linkin Park"


# --------------------------------------------------------- /api/album/{id}/match
def test_album_match_album_primero_y_puntuales_solo_para_las_que_faltan(
        cliente, monkeypatch):
    import backend.app.main as main
    from backend.app.sources import ITunesSource

    canciones = [_song(i, f"P{i}") for i in range(1, 6)]  # 5 pistas

    async def _lookup(self, album_id):
        return None, list(canciones)

    monkeypatch.setattr(ITunesSource, "lookup", _lookup)

    class YtDlp:
        def available(self):
            return True

    monkeypatch.setitem(main.BY_NAME, "ytdlp", YtDlp())
    monkeypatch.setattr(main, "_ALBUM_MATCH_CACHE", {})

    llamadas = []
    activos = {"n": 0, "max": 0}

    async def _enrich(tracks, query, ysrc, limit=40):
        llamadas.append((len(tracks), query, limit))
        clave = str(tracks[0]["trackId"])
        if len(tracks) > 1:
            # la busqueda del album solo empareja la primera pista
            salida = {str(t["trackId"]): {"video": None, "score": 0.0,
                                          "why": "sin-señal"}
                      for t in tracks}
            salida[clave] = {
                "video": {"id": "v1", "title": "P1", "uploader": "Linkin Park"},
                "score": 0.9, "why": "canal",
                "webpage_url": "https://www.youtube.com/watch?v=v1",
            }
            return salida
        # busqueda puntual (una pista): mide la concurrencia real
        activos["n"] += 1
        activos["max"] = max(activos["max"], activos["n"])
        await asyncio.sleep(0.02)
        activos["n"] -= 1
        return {clave: {
            "video": {"id": f"v{clave}", "title": f"P{clave}",
                      "uploader": "Linkin Park"},
            "score": 0.88, "why": "titulo",
            "webpage_url": f"https://www.youtube.com/watch?v=v{clave}",
        }}

    monkeypatch.setattr("backend.app.matcher.enrich_with_ytdlp", _enrich)

    r = cliente.get("/api/album/999/match")
    assert r.status_code == 200
    body = r.json()
    assert body["ytdlp"] is True
    assert body["full"] == 5
    assert all(t["extra"]["has_full"] for t in body["tracks"])

    # la primera busqueda es la del album, con el limite normal
    assert llamadas[0][0] == 5 and llamadas[0][2] == 40
    assert llamadas[0][1] == "Linkin Park Meteora"
    puntuales = [c for c in llamadas if c[0] == 1]
    assert len(puntuales) == 4
    assert all(c[2] == main._ALBUM_TRACK_LIMIT for c in puntuales)
    assert activos["max"] <= 3 and activos["max"] >= 2

    # la respuesta se cachea: abrir otra vez no busca en YouTube
    antes = list(llamadas)
    r2 = cliente.get("/api/album/999/match")
    assert r2.status_code == 200 and r2.json() == body
    assert llamadas == antes


def test_album_match_las_puntuales_usan_el_artista_de_la_pista(
        cliente, monkeypatch):
    import backend.app.main as main
    from backend.app.sources import ITunesSource

    coleccion = _collection(collectionName="Recopilatorio",
                            artistName="Varios artistas")
    canciones = []
    for n in (1, 2):
        cancion = _song(n, f"P{n}")
        cancion["artistName"] = f"Artista {n}"
        canciones.append(cancion)

    async def _lookup(self, album_id):
        return coleccion, canciones

    monkeypatch.setattr(ITunesSource, "lookup", _lookup)

    class YtDlp:
        def available(self):
            return True

    monkeypatch.setitem(main.BY_NAME, "ytdlp", YtDlp())
    monkeypatch.setattr(main, "_ALBUM_MATCH_CACHE", {})

    consultas = []

    async def _enrich(tracks, query, ysrc, limit=40):
        consultas.append(query)
        return {}  # todas quedan sin video: se buscan sueltas

    monkeypatch.setattr("backend.app.matcher.enrich_with_ytdlp", _enrich)

    r = cliente.get("/api/album/999/match")
    assert r.status_code == 200
    assert consultas[0] == "Varios artistas Recopilatorio"
    assert sorted(consultas[1:]) == ["Artista 1 P1", "Artista 2 P2"]


def test_album_id_no_digito_da_404_sin_llamar_a_itunes(cliente, monkeypatch):
    from backend.app.sources import ITunesSource

    vistos = []

    async def _lookup(self, album_id):
        vistos.append(album_id)
        return _collection(), [_song(1, "Uno")]

    monkeypatch.setattr(ITunesSource, "lookup", _lookup)
    for ruta in ("/api/album/abc", "/api/album/abc/match"):
        r = cliente.get(ruta)
        assert r.status_code == 404
        assert r.json()["detail"] == "album no encontrado"
    assert vistos == []


@pytest.mark.parametrize("ruta", ["/api/album/999", "/api/album/999/match"])
@pytest.mark.parametrize("fallo", ["red", "http"])
def test_fallo_de_itunes_da_502(cliente, monkeypatch, ruta, fallo):
    import httpx

    from backend.app.sources import ITunesSource

    if fallo == "red":
        error = httpx.ConnectError("sin red")
    else:
        req = httpx.Request("GET", "https://itunes.apple.com/lookup")
        error = httpx.HTTPStatusError("500", request=req,
                                      response=httpx.Response(500, request=req))

    async def _roto(self, album_id):
        raise error

    monkeypatch.setattr(ITunesSource, "lookup", _roto)
    r = cliente.get(ruta)
    assert r.status_code == 502
    assert r.json()["detail"] == "iTunes no respondio"


def test_album_match_sin_ytdlp(cliente, monkeypatch):
    import backend.app.main as main
    from backend.app.sources import ITunesSource

    async def _lookup(self, album_id):
        return None, [_song(1, "P1")]

    monkeypatch.setattr(ITunesSource, "lookup", _lookup)

    class Apagada:
        def available(self):
            return False

    monkeypatch.setitem(main.BY_NAME, "ytdlp", Apagada())
    monkeypatch.setattr(main, "_ALBUM_MATCH_CACHE", {})
    monkeypatch.setattr("backend.app.matcher.enrich_with_ytdlp", _enrich_vacio)

    r = cliente.get("/api/album/999/match")
    assert r.status_code == 200
    body = r.json()
    assert body["ytdlp"] is False
    assert body["full"] == 0
    assert all(t["extra"]["has_full"] is False for t in body["tracks"])


# ----------------------------------------------------------------------- tags
def _track_con_album():
    return Track(source="itunes", source_id="1", title="Numb",
                 artist="Linkin Park", album="Meteora", year="2003",
                 extra={"track_number": 3, "track_count": 12,
                        "disc_number": 1, "disc_count": 2,
                        "collection_id": 999})


def test_tags_de_album_en_mp3(tmp_path, mp3_desde_wav):
    from mutagen.id3 import ID3

    from backend.app.downloader import _write_tags

    archivo = tmp_path / "numb.mp3"
    archivo.write_bytes(mp3_desde_wav.read_bytes())
    _write_tags(archivo, _track_con_album())

    tags = ID3(str(archivo))
    assert str(tags["TRCK"].text[0]) == "3/12"
    assert str(tags["TPOS"].text[0]) == "1/2"
    assert str(tags["TXXX:ITUNES_COLLECTION_ID"].text[0]) == "999"


def test_tags_de_album_en_m4a(tmp_path, ffmpeg, wav_sintetico):
    from mutagen.mp4 import MP4

    from backend.app.downloader import _write_tags

    archivo = tmp_path / "numb.m4a"
    subprocess.run(["ffmpeg", "-y", "-i", str(wav_sintetico), "-vn",
                    "-c:a", "aac", "-b:a", "128k", str(archivo)],
                   check=True, capture_output=True)
    _write_tags(archivo, _track_con_album())

    tags = MP4(str(archivo))
    assert tags["trkn"][0] == (3, 12)
    assert tags["disk"][0] == (1, 2)
    libre = tags["----:com.apple.iTunes:ITUNES_COLLECTION_ID"][0]
    datos = getattr(libre, "data", libre)
    if isinstance(datos, bytes):
        datos = datos.decode("utf-8")
    assert str(datos) == "999"


# ------------------------------------------------------------------ biblioteca
def test_libreria_expone_el_orden_de_album(tmp_path, mp3_desde_wav,
                                           storage_temporal):
    from backend.app.downloader import _write_tags, library_scan

    storage_temporal(tmp_path / "lib")
    destino = tmp_path / "lib" / "Linkin Park - Numb.mp3"
    destino.write_bytes(mp3_desde_wav.read_bytes())
    _write_tags(destino, _track_con_album())

    filas = [f for f in library_scan()
             if f["key"] == "Linkin Park - Numb.mp3"]
    assert len(filas) == 1
    assert filas[0]["track_no"] == 3
    assert filas[0]["disc_no"] == 1
    assert filas[0]["album_id"] == "999"


def test_libreria_archivo_sin_tags_de_album_da_none(tmp_path, mp3_desde_wav,
                                                    storage_temporal):
    from backend.app.downloader import library_scan

    storage_temporal(tmp_path / "lib")
    (tmp_path / "lib" / "viejo.mp3").write_bytes(mp3_desde_wav.read_bytes())

    (fila,) = [f for f in library_scan() if f["key"] == "viejo.mp3"]
    assert fila["track_no"] is None
    assert fila["disc_no"] is None
    assert fila["album_id"] is None


# ------------------------------------------------------------- una sola lectura
def _archivo_con_tags(tmp_path, ext, ffmpeg, wav_sintetico, mp3_desde_wav):
    from backend.app.downloader import _write_tags

    archivo = tmp_path / f"numb.{ext}"
    if ext == "mp3":
        archivo.write_bytes(mp3_desde_wav.read_bytes())
    else:
        subprocess.run(["ffmpeg", "-y", "-i", str(wav_sintetico), "-vn",
                        "-c:a", "aac", "-b:a", "128k", str(archivo)],
                       check=True, capture_output=True)
    _write_tags(archivo, _track_con_album())
    return archivo


def test_media_info_abre_el_archivo_una_sola_vez(tmp_path, monkeypatch,
                                                 mp3_desde_wav):
    import mutagen

    from backend.app.storage import local

    archivo = _archivo_con_tags(tmp_path, "mp3", None, None, mp3_desde_wav)
    real = mutagen.File
    llamadas = []

    def contado(*args, **kwargs):
        llamadas.append((args, kwargs))
        return real(*args, **kwargs)

    monkeypatch.setattr(mutagen, "File", contado)
    dur, titulo, artista, album, pista, disco, album_id = local._media_info(
        archivo)
    assert len(llamadas) == 1
    assert (titulo, artista, album) == ("Numb", "Linkin Park", "Meteora")
    assert (pista, disco, album_id) == (3, 1, "999")
    assert dur is not None


@pytest.mark.parametrize("ext", ["mp3", "m4a"])
def test_round_trip_easy_de_album(tmp_path, ext, ffmpeg, wav_sintetico,
                                  mp3_desde_wav):
    from mutagen import File as MFile

    from backend.app.tagkeys import easy_album_id, easy_number

    archivo = _archivo_con_tags(tmp_path, ext, ffmpeg, wav_sintetico,
                                mp3_desde_wav)
    easy = MFile(archivo, easy=True)
    assert easy_number(easy, "tracknumber") == 3
    assert easy_number(easy, "discnumber") == 1
    assert easy_album_id(easy) == "999"


# --------------------------------------------------------------- indice de nube
def _entrada_indice(**campos):
    from backend.app.cloud.library_index import IndexEntry

    base = dict(key="A/x.mp3", remote_id="rid", revision="rev1", title="x",
                artist="A", album="Alb", duration=12.5, size=100,
                format="mp3", updated_at=1.0)
    base.update(campos)
    return IndexEntry(**base)


def test_indice_drive_round_trip_con_campos_de_album():
    from backend.app.cloud.library_index import LibraryIndex

    entrada = _entrada_indice(track_no=3, disc_no=1, album_id="999")
    index = LibraryIndex()
    index.upsert(entrada)
    otra = LibraryIndex.from_bytes(index.to_bytes())
    assert otra.entries["A/x.mp3"] == entrada
    assert (otra.entries["A/x.mp3"].track_no,
            otra.entries["A/x.mp3"].disc_no,
            otra.entries["A/x.mp3"].album_id) == (3, 1, "999")


def test_indice_drive_viejo_sin_campos_sigue_cargando():
    from backend.app.cloud.library_index import LibraryIndex

    viejo = {"version": 1, "entries": [{
        "key": "A/x.mp3", "remote_id": "rid", "revision": "rev1",
        "title": "x", "artist": "A", "album": "Alb", "duration": 12.5,
        "size": 100, "format": "mp3", "updated_at": 1.0,
        # Sin track_no/disc_no/album_id, como los indices de antes.
    }]}
    index = LibraryIndex.from_bytes(json.dumps(viejo).encode())
    entrada = index.entries["A/x.mp3"]
    assert (entrada.track_no, entrada.disc_no, entrada.album_id) == (
        None, None, None)

    # Un valor mal formado tampoco rompe la carga: da None.
    viejo["entries"][0].update(track_no="no es numero", disc_no=[],
                               album_id=None)
    otra = LibraryIndex.from_bytes(json.dumps(viejo).encode())
    entrada = otra.entries["A/x.mp3"]
    assert (entrada.track_no, entrada.disc_no, entrada.album_id) == (
        None, None, None)


def _drive(tmp_path):
    import httpx

    from backend.app.cloud.drive import DriveStorage
    from fake_drive import FakeDrive

    class Tokens:
        def access_token(self):
            return "token"

        def invalidate(self):
            pass

    fake = FakeDrive()
    client = httpx.Client(transport=httpx.MockTransport(fake))
    return DriveStorage(Tokens(), client, "devA", cache=None)


def test_drive_sube_y_expone_los_campos_de_album(tmp_path, mp3_desde_wav):
    storage = _drive(tmp_path)
    archivo = _archivo_con_tags(tmp_path, "mp3", None, None, mp3_desde_wav)
    storage.put_file("A/numb.mp3", archivo)

    (fila,) = storage.list()
    assert (fila.track_no, fila.disc_no, fila.album_id) == (3, 1, "999")
    estado = storage.stat("A/numb.mp3")
    assert (estado.track_no, estado.disc_no, estado.album_id) == (
        3, 1, "999")
