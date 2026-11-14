"""«Buscar portadas»: lista, candidatas de iTunes y guardado confirmado.

Todo OFFLINE: la busqueda de iTunes y la bajada del CDN son dobles. La
biblioteca es un `LocalStorage` en `tmp_path`, nunca la real.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from backend.app import cover_finder, covers
from backend.app.cover_finder import Offers, suggested_query
from backend.app.main import create_app
from backend.app.storage import set_storage
from backend.app.storage.local import LocalStorage

ART = ("https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/bb/cc/"
       "{n}/100x100bb.jpg")
JPG = b"\xff\xd8\xff\xe0portada-"


def _song(n: int, **extra) -> dict:
    return {"kind": "song", "trackName": f"Tema {n}", "artistName": "Artista",
            "collectionName": f"Album {n}", "releaseDate": "2004-05-01T00:00:00Z",
            "artworkUrl100": ART.format(n=n), **extra}


def _big(n: int) -> str:
    return ART.format(n=n).replace("100x100", "300x300")


def _poner(root: Path, *claves: str) -> None:
    for clave in claves:
        ruta = root / clave
        ruta.parent.mkdir(parents=True, exist_ok=True)
        ruta.write_bytes(b"\x00" * 16)


@pytest.fixture
def api(tmp_path, monkeypatch):
    root = tmp_path / "lib"
    root.mkdir()
    storage = LocalStorage(root)
    set_storage(storage)
    monkeypatch.setattr(cover_finder, "OFFERS", Offers())
    busquedas: list[str] = []
    resultados: list[dict] = [_song(1), _song(2)]

    async def itunes(q):
        busquedas.append(q)
        return list(resultados)

    monkeypatch.setattr(cover_finder, "_itunes_search", itunes)

    async def cdn(client, url):
        return JPG + url.encode()

    monkeypatch.setattr(covers, "_get", cdn)
    try:
        with TestClient(create_app()) as client:
            yield client, root, busquedas, resultados, storage
    finally:
        set_storage(None)


def _buscar(client, key, q="artista tema"):
    return client.get("/api/covers/candidates", params={"key": key, "q": q})


def _guardar(client, key, url):
    return client.post("/api/covers/apply", json={"key": key, "artwork_url": url})


# ----------------------------------------------------------------- busqueda sugerida
@pytest.mark.parametrize("row,esperado", [
    ({"title": "Crimen", "artist": "Cerati", "filename": "x.mp3"}, "Cerati Crimen"),
    ({"title": "Crimen", "artist": None, "filename": "x.mp3"}, "Crimen"),
    ({"title": None, "artist": "Cerati", "filename": "track07_final.mp3"},
     "track07 final"),
    ({"title": "  ", "artist": "", "filename": "A - B.m4a"}, "A - B"),
])
def test_la_busqueda_sale_de_las_etiquetas_o_del_nombre(row, esperado):
    assert suggested_query(row) == esperado


# ------------------------------------------------------------------- /missing
def test_lista_solo_audio_sin_portada(api):
    client, root, *_ = api
    _poner(root, "A/tiene.mp3", "A/tiene.jpg", "A/sin.mp3", "A/video.mp4",
           "B/otra.flac")

    r = client.get("/api/covers/missing")

    assert r.status_code == 200
    keys = sorted(i["key"] for i in r.json()["items"])
    assert keys == ["A/sin.mp3", "B/otra.flac"]
    assert r.json()["count"] == 2
    fila = next(i for i in r.json()["items"] if i["key"] == "A/sin.mp3")
    assert fila["query"] == "sin" and fila["filename"] == "sin.mp3"


# ---------------------------------------------------------------- /candidates
def test_devuelve_canciones_reales_con_portada_sin_preseleccion(api):
    client, root, busquedas, resultados, _ = api
    _poner(root, "A/uno.mp3")
    resultados[:] = [_song(1), _song(2, artworkUrl100=None), _song(1),
                     {"kind": "song", "trackName": "Raro",
                      "artworkUrl100": "https://evil.com/100x100bb.jpg"}]

    r = _buscar(client, "A/uno.mp3", "  artista   tema ")

    assert r.status_code == 200
    assert busquedas == ["artista tema"]
    cands = r.json()["candidates"]
    assert cands == [{"title": "Tema 1", "artist": "Artista", "album": "Album 1",
                      "year": "2004", "artwork_url": _big(1)}]
    assert not any("selected" in c for c in cands)


def test_corta_en_seis_candidatas(api):
    client, root, _, resultados, _ = api
    _poner(root, "A/uno.mp3")
    resultados[:] = [_song(n) for n in range(10)]

    assert len(_buscar(client, "A/uno.mp3").json()["candidates"]) == 6


@pytest.mark.parametrize("key,status", [
    ("A/no-existe.mp3", 404),
    ("A/video.mp4", 404),
    ("A/tiene.mp3", 409),
    ("../fuera.mp3", 404),
])
def test_candidatas_solo_para_audio_existente_sin_portada(api, key, status):
    client, root, busquedas, *_ = api
    _poner(root, "A/video.mp4", "A/tiene.mp3", "A/tiene.jpg")

    assert _buscar(client, key).status_code == status
    assert busquedas == []


def test_una_busqueda_vacia_no_llega_a_itunes(api):
    client, root, busquedas, *_ = api
    _poner(root, "A/uno.mp3")

    assert _buscar(client, "A/uno.mp3", "   ").status_code == 422
    assert busquedas == []


def test_si_itunes_falla_responde_502(api, monkeypatch):
    client, root, *_ = api
    _poner(root, "A/uno.mp3")

    async def caido(q):
        raise RuntimeError("timeout")

    monkeypatch.setattr(cover_finder, "_itunes_search", caido)
    assert _buscar(client, "A/uno.mp3").status_code == 502


# --------------------------------------------------------------------- /apply
def test_guarda_las_dos_portadas_en_un_solo_put_files(api, monkeypatch):
    client, root, _, _, storage = api
    _poner(root, "A/uno.mp3")
    llamadas: list[list[str]] = []
    original = storage.put_files

    def espia(items):
        llamadas.append([k for k, _ in items])
        return original(items)

    monkeypatch.setattr(storage, "put_files", espia)
    _buscar(client, "A/uno.mp3")

    r = _guardar(client, "A/uno.mp3", _big(2))

    assert r.status_code == 200
    assert r.json() == {"key": "A/uno.mp3", "thumb_key": "A/uno.jpg",
                        "thumb_s": True}
    assert llamadas == [["A/uno.jpg", "A/uno.s.jpg"]]
    assert (root / "A/uno.jpg").read_bytes().endswith(b"/200x200bb.jpg")
    assert (root / "A/uno.s.jpg").read_bytes().endswith(b"/100x100bb.jpg")
    # Ya tiene portada: deja de aparecer en la lista.
    assert client.get("/api/covers/missing").json()["count"] == 0


def test_no_guarda_una_portada_que_no_se_ofrecio_para_ese_tema(api):
    client, root, *_ = api
    _poner(root, "A/uno.mp3", "A/dos.mp3")
    _buscar(client, "A/uno.mp3")

    # De iTunes, pero nunca se ofrecio para "A/dos.mp3".
    assert _guardar(client, "A/dos.mp3", _big(1)).status_code == 400
    # Ofrecida para el tema, pero con otro tamano: no es la misma URL.
    assert _guardar(client, "A/uno.mp3", ART.format(n=1)).status_code == 400
    assert not (root / "A/dos.jpg").exists()
    assert not (root / "A/uno.jpg").exists()


def test_la_oferta_vence():
    ahora = [0.0]
    offers = Offers(ttl=10, clock=lambda: ahora[0])
    offers.remember("A/uno.mp3", ["u"])
    assert offers.offered("A/uno.mp3", "u")
    ahora[0] = 11
    assert not offers.offered("A/uno.mp3", "u")


def test_otra_busqueda_suma_ofertas_sin_borrar_las_anteriores(api):
    client, root, _, resultados, _ = api
    _poner(root, "A/uno.mp3")
    _buscar(client, "A/uno.mp3")
    resultados[:] = [_song(7)]
    _buscar(client, "A/uno.mp3", "otra cosa")

    assert _guardar(client, "A/uno.mp3", _big(1)).status_code == 200


def test_no_pisa_una_portada_que_aparecio_mientras_tanto(api):
    client, root, *_ = api
    _poner(root, "A/uno.mp3")
    _buscar(client, "A/uno.mp3")
    (root / "A/uno.jpg").write_bytes(b"de otro dispositivo")

    assert _guardar(client, "A/uno.mp3", _big(1)).status_code == 409
    assert (root / "A/uno.jpg").read_bytes() == b"de otro dispositivo"


def test_si_el_cdn_falla_no_se_escribe_nada(api, monkeypatch):
    client, root, *_ = api
    _poner(root, "A/uno.mp3")
    _buscar(client, "A/uno.mp3")

    async def roto(client, url):
        raise ValueError("503")

    monkeypatch.setattr(covers, "_get", roto)
    assert _guardar(client, "A/uno.mp3", _big(1)).status_code == 502
    assert not (root / "A/uno.jpg").exists()
    assert not (root / "A/uno.s.jpg").exists()


def test_un_segundo_guardado_del_mismo_tema_se_rechaza(api):
    client, root, *_ = api
    _poner(root, "A/uno.mp3")
    _buscar(client, "A/uno.mp3")

    assert _guardar(client, "A/uno.mp3", _big(1)).status_code == 200
    assert _guardar(client, "A/uno.mp3", _big(2)).status_code == 400


def test_guardar_no_toca_el_veredicto(api, monkeypatch):
    client, root, _, _, storage = api
    _poner(root, "A/uno.mp3")

    def no_debe_llamarse(*a, **k):
        raise AssertionError("no se escribe fileinfo")

    monkeypatch.setattr(storage, "save_fileinfo", no_debe_llamarse)
    _buscar(client, "A/uno.mp3")
    assert _guardar(client, "A/uno.mp3", _big(1)).status_code == 200


def test_apply_pide_clave_y_url(api):
    client, *_ = api
    assert client.post("/api/covers/apply", json={"key": "A/uno.mp3"}).status_code == 422
    assert client.post("/api/covers/apply",
                       json={"artwork_url": _big(1)}).status_code == 422
