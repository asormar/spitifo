"""Imagenes personalizadas (ADR 0005): modelo, almacenamiento y API.

Todo OFFLINE: el modelo es puro, la API corre sobre un `LocalStorage` en una
carpeta temporal y la bajada de URLs se reemplaza por un `MockTransport`.
"""
from __future__ import annotations

import base64
import hashlib
import json

import httpx
import pytest
from starlette.testclient import TestClient

from backend.app.art import (
    ART_DIR,
    MAX_IMAGE_BYTES,
    MAX_SMALL_BYTES,
    SOURCE_ARCHIVE,
    SOURCE_ITUNES,
    SOURCE_UPLOAD,
    SOURCE_YOUTUBE,
    ArtBook,
    ArtFormatError,
    ArtRecord,
    art_keys,
    mzstatic_variants,
    validate_art_url,
    validate_image,
    validate_source,
    validate_target,
)
from backend.app.main import create_app
from backend.app.storage import set_storage
from backend.app.storage.local import LocalStorage

SONG = "song:yt:dQw4w9WgXcQ"
ALBUM = "album:abbey road"
ARTIST = "artist:the beatles"
BIG = b"\xff\xd8\xff\xe0" + b"B" * 96
SMALL = b"\xff\xd8\xff\xe0" + b"S" * 48


def _rec(target=SONG, big=BIG, source=SOURCE_UPLOAD, *, updated_at=1.0,
         deleted=False):
    big_key, small_key = art_keys(hashlib.sha256(big).hexdigest())
    return ArtRecord(target=target, key=big_key, small_key=small_key,
                     source=source, updated_at=updated_at, deleted=deleted)


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


# --------------------------------------------------------------------- targets
def test_validate_target_acepta_cancion_guardada_archivo_album_y_artista():
    assert validate_target(SONG) == SONG
    assert validate_target("song:ia:olivia-1969/01 Olivia.mp3")
    assert validate_target("song:A/t.mp3")
    assert validate_target(ALBUM) == ALBUM
    assert validate_target(ARTIST) == ARTIST


@pytest.mark.parametrize("target", [
    "", 7, None, "song:", "yt:dQw4w9WgXcQ", "song:yt:corto",
    "song:../fuera.mp3", "song:https://stream.example/x.mp3",
    "album:", "artist:" + "a" * 301, "album:Rock & Roll",  # no es folded
    "album:a\x01b", "playlist:cosa", "song:a/b:c",
])
def test_validate_target_rechaza_lo_demas(target):
    with pytest.raises(ValueError):
        validate_target(target)


def test_validate_source_y_limites_de_imagen():
    for source in (SOURCE_UPLOAD, SOURCE_ITUNES, SOURCE_YOUTUBE,
                   SOURCE_ARCHIVE):
        assert validate_source(source) == source
    with pytest.raises(ValueError):
        validate_source("spotify")
    assert validate_image(BIG, MAX_IMAGE_BYTES, "image") == BIG
    for bad in (None, b"no es jpeg", b"\xff\xd8" + b"x" * 10,
                b"\xff\xd8\xff" + b"x" * (MAX_IMAGE_BYTES + 1)):
        with pytest.raises(ValueError):
            validate_image(bad, MAX_IMAGE_BYTES, "image")
    with pytest.raises(ValueError):
        validate_image(b"\xff\xd8\xff" + b"x" * MAX_SMALL_BYTES,
                       MAX_SMALL_BYTES, "small")


# ------------------------------------------------------------------------- urls
@pytest.mark.parametrize("url,source", [
    ("https://is1-ssl.mzstatic.com/image/thumb/Music/100x100bb.jpg", "itunes"),
    ("https://i.ytimg.com/vi/abc/hqdefault.jpg", "youtube"),
    ("https://archive.org/services/img/olivia-1969", "archive"),
    ("https://ia800300.us.archive.org/3/items/x/cover.jpg", "archive"),
])
def test_validate_art_url_acepta_la_lista(url, source):
    assert validate_art_url(url, source) == url


@pytest.mark.parametrize("url,source", [
    ("http://i.ytimg.com/vi/a/x.jpg", "youtube"),
    ("https://evil.example/x.jpg", "youtube"),
    ("https://i.ytimg.com.evil.example/x.jpg", "youtube"),
    ("https://user:pw@i.ytimg.com/x.jpg", "youtube"),
    ("https://i.ytimg.com:8443/x.jpg", "youtube"),
    ("https://i.ytimg.com/x.jpg?q=1", "youtube"),
    ("https://i.ytimg.com/x.jpg", "itunes"),  # no coincide con la fuente
    ("https://i.ytimg.com/x.jpg", "upload"),
])
def test_validate_art_url_rechaza(url, source):
    with pytest.raises(ValueError):
        validate_art_url(url, source)


def test_mzstatic_variants_y_claves_son_validas():
    url = "https://is1.mzstatic.com/image/thumb/Music/300x300bb.jpg"
    assert mzstatic_variants(url) == (
        "https://is1.mzstatic.com/image/thumb/Music/600x600bb.jpg",
        "https://is1.mzstatic.com/image/thumb/Music/120x120bb.jpg")
    assert mzstatic_variants("https://i.ytimg.com/x.jpg") is None
    big_key, small_key = art_keys("ab" * 32)
    assert big_key.startswith(f"{ART_DIR}/") and big_key.endswith(".jpg")
    assert small_key == big_key[:-4] + ".s.jpg"


# ------------------------------------------------------- serializacion y merge
def test_round_trip_con_bytes_estables():
    book = ArtBook()
    book.upsert(_rec(ALBUM, source=SOURCE_ITUNES, updated_at=2.0))
    book.upsert(_rec(SONG, updated_at=1.0))
    data = book.to_bytes()
    again = ArtBook.from_bytes(data)
    assert again.to_bytes() == data
    assert set(again.records) == {SONG, ALBUM}
    assert [r["target"] for r in json.loads(data)["art"]] == sorted([SONG, ALBUM])


@pytest.mark.parametrize("data", [b"{no es json", b"[]",
                                   json.dumps({"version": 2, "art": []}).encode()])
def test_bytes_malos_se_rechazan(data):
    with pytest.raises(ArtFormatError):
        ArtBook.from_bytes(data)


def test_from_bytes_salta_registros_mal_formados():
    payload = {"version": 1, "art": [
        {"target": SONG, "key": ".art/a.jpg", "small_key": ".art/a.s.jpg",
         "source": "upload", "updated_at": 1},
        {"target": "target invalido", "key": ".art/a.jpg",
         "small_key": ".art/a.s.jpg", "source": "upload", "updated_at": 1},
        "no es un dict",
    ]}
    assert set(ArtBook.from_bytes(json.dumps(payload).encode()).records) == {SONG}


def test_remove_escribe_tombstone_y_lo_salta_live():
    book = ArtBook()
    book.upsert(_rec())
    book.remove(SONG, now=9.0)
    assert book.records[SONG].deleted is True
    assert book.records[SONG].key  # se conserva
    assert book.records[SONG].updated_at == 9.0
    assert book.live() == []


def test_remove_de_un_target_desconocido_deja_tombstone_valido():
    book = ArtBook()
    book.remove(ARTIST, now=5.0)
    tomb = book.records[ARTIST]
    assert (tomb.deleted, tomb.key, tomb.small_key) == (True, "", "")
    assert ArtBook.from_bytes(book.to_bytes()).records[ARTIST] == tomb


def test_live_ordena_por_updated_at_nuevo_primero():
    book = ArtBook()
    book.upsert(_rec(SONG, updated_at=1.0))
    book.upsert(_rec(ALBUM, updated_at=9.0))
    assert [r.target for r in book.live()] == [ALBUM, SONG]


def test_merge_gana_el_mas_nuevo_y_en_empate_el_tombstone():
    viejo, nuevo = ArtBook(), ArtBook()
    viejo.upsert(_rec(updated_at=10.0))
    nuevo.upsert(_rec(source=SOURCE_ITUNES, updated_at=20.0))
    assert viejo.merge(nuevo).records[SONG].source == SOURCE_ITUNES

    vivo, muerto = ArtBook(), ArtBook()
    vivo.upsert(_rec(updated_at=10.0))
    muerto.remove(SONG, now=10.0)
    assert vivo.merge(muerto).records[SONG].deleted is True
    assert muerto.merge(vivo).records[SONG].deleted is True


def test_merge_junta_targets_y_revive_un_tombstone_viejo():
    a, b = ArtBook(), ArtBook()
    a.upsert(_rec(SONG, updated_at=10.0))
    b.remove(ALBUM, now=10.0)
    b.upsert(_rec(SONG, source=SOURCE_YOUTUBE, updated_at=20.0))
    merged = a.merge(b)
    assert {r.target for r in merged.live()} == {SONG}
    assert merged.records[ALBUM].deleted is True


# ---------------------------------------------------------------------- API
@pytest.fixture
def api(tmp_path):
    root = tmp_path / "lib"
    root.mkdir()
    storage = LocalStorage(root)
    set_storage(storage)
    try:
        with TestClient(create_app()) as c:
            yield c, root, storage
    finally:
        set_storage(None)


def test_get_art_arranca_vacio(api):
    c, _root, _storage = api
    assert c.get("/api/art").json() == {"art": {}}


def test_upload_guarda_y_devuelve_claves_content_addressed(api):
    c, _root, _storage = api
    r = c.post("/api/art/upload", json={"target": SONG,
                                        "image": _b64(BIG), "small": _b64(SMALL)})
    assert r.status_code == 200
    rec = r.json()
    digest = hashlib.sha256(BIG).hexdigest()
    assert rec == {"target": SONG,
                   "key": f"{ART_DIR}/{digest}.jpg",
                   "small_key": f"{ART_DIR}/{digest}.s.jpg",
                   "source": SOURCE_UPLOAD}
    assert c.get("/api/art").json() == {"art": {
        SONG: {"key": rec["key"], "small_key": rec["small_key"],
               "source": SOURCE_UPLOAD}}}


@pytest.mark.parametrize("body", [
    {"target": SONG, "image": _b64(BIG)},
    {"target": "target invalido", "image": _b64(BIG), "small": _b64(SMALL)},
    {"target": SONG, "image": "no base64!!", "small": _b64(SMALL)},
    {"target": SONG, "image": _b64(b"no jpeg"), "small": _b64(SMALL)},
    {"target": SONG, "image": _b64(BIG), "small": _b64(b"no jpeg")},
    {"target": SONG, "image": _b64(BIG), "small": _b64(SMALL + b"x" * MAX_SMALL_BYTES)},
])
def test_upload_invalido_da_422(api, body):
    c, _root, _storage = api
    assert c.post("/api/art/upload", json=body).status_code == 422


def test_upload_identico_no_vuelve_a_escribir(api, monkeypatch):
    c, _root, storage = api
    calls = []
    real = storage.put_files

    def spy(items):
        calls.append(items)
        return real(items)

    monkeypatch.setattr(storage, "put_files", spy)
    body = {"target": SONG, "image": _b64(BIG), "small": _b64(SMALL)}
    first = c.post("/api/art/upload", json=body).json()
    second = c.post("/api/art/upload", json=body).json()
    assert first["key"] == second["key"]
    assert len(calls) == 1


def test_archivos_art_no_aparecen_en_library_ni_en_portadas(api):
    c, root, _storage = api
    c.post("/api/art/upload", json={"target": SONG,
                                    "image": _b64(BIG), "small": _b64(SMALL)})
    assert (root / ART_DIR).is_dir()
    assert list((root / ART_DIR).glob("*.jpg"))
    assert c.get("/api/library").json()["count"] == 0
    assert c.get("/api/covers/missing").json()["count"] == 0
    # El registro es oculto, igual que library.json.
    assert (root / ".spitifo" / "art.json").is_file()
    assert not (root / ".spitifo" / "art.json").name.startswith(".")


def test_art_local_ilegible_no_se_pisa(api):
    c, root, _storage = api
    c.post("/api/art/upload", json={"target": SONG,
                                    "image": _b64(BIG), "small": _b64(SMALL)})
    path = root / ".spitifo" / "art.json"
    path.write_bytes(b"{roto")
    assert c.get("/api/art").json() == {"art": {}}
    with pytest.raises(RuntimeError):
        c.post("/api/art/upload", json={"target": SONG,
                                        "image": _b64(BIG), "small": _b64(SMALL)})
    assert path.read_bytes() == b"{roto"


def test_api_audio_sirve_art_con_cache_larga(api):
    c, _root, _storage = api
    rec = c.post("/api/art/upload", json={"target": SONG,
                                          "image": _b64(BIG),
                                          "small": _b64(SMALL)}).json()
    r = c.get("/api/audio", params={"key": rec["key"]})
    assert r.status_code == 200
    assert r.content == BIG
    assert "max-age=31536000" in r.headers["cache-control"]
    assert "immutable" in r.headers["cache-control"]


def test_reset_tombstone_y_reupload_revive(api):
    c, _root, _storage = api
    c.post("/api/art/upload", json={"target": SONG,
                                    "image": _b64(BIG), "small": _b64(SMALL)})
    assert c.post("/api/art/reset", json={"target": SONG}).json() == {"art": {}}
    assert c.get("/api/art").json() == {"art": {}}
    revived = c.post("/api/art/upload", json={
        "target": SONG, "image": _b64(BIG), "small": _b64(SMALL)})
    assert revived.status_code == 200
    assert SONG in c.get("/api/art").json()["art"]


def test_reset_target_invalido_da_422(api):
    c, _root, _storage = api
    assert c.post("/api/art/reset", json={"target": "nope"}).status_code == 422


# ---------------------------------------------------------------- from-url
ITUNES_URL = "https://is1-ssl.mzstatic.com/image/thumb/Music/300x300bb.jpg"
YT_URL = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"


def _mock_fetch(monkeypatch, handler):
    import backend.app.main as main_mod

    def factory():
        return httpx.AsyncClient(transport=httpx.MockTransport(handler),
                                 timeout=httpx.Timeout(5.0))

    monkeypatch.setattr(main_mod, "_art_client", factory)


def test_from_url_itunes_deriva_variantes(api, monkeypatch):
    c, _root, _storage = api
    seen = []

    def handler(request):
        seen.append(request.url.path)
        data = BIG if "600x600bb" in request.url.path else SMALL
        return httpx.Response(200, content=data)

    _mock_fetch(monkeypatch, handler)
    r = c.post("/api/art/from-url", json={"target": ALBUM, "url": ITUNES_URL,
                                          "source": SOURCE_ITUNES})
    assert r.status_code == 200
    assert r.json()["source"] == SOURCE_ITUNES
    assert sorted(seen) == sorted([
        "/image/thumb/Music/600x600bb.jpg",
        "/image/thumb/Music/120x120bb.jpg"])
    stored = c.get("/api/art").json()["art"][ALBUM]
    assert stored["key"] == f"{ART_DIR}/{hashlib.sha256(BIG).hexdigest()}.jpg"


def test_from_url_youtube_usa_los_mismos_bytes(api, monkeypatch):
    c, _root, _storage = api
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(200, content=BIG)

    _mock_fetch(monkeypatch, handler)
    r = c.post("/api/art/from-url", json={"target": SONG, "url": YT_URL,
                                          "source": SOURCE_YOUTUBE})
    assert r.status_code == 200
    assert seen == [YT_URL, YT_URL]
    stored = c.get("/api/art").json()["art"][SONG]
    assert stored["small_key"] == stored["key"][:-4] + ".s.jpg"


@pytest.mark.parametrize("url,source,status", [
    ("https://evil.example/x.jpg", SOURCE_YOUTUBE, 422),
    ("http://i.ytimg.com/x.jpg", SOURCE_YOUTUBE, 422),
    ("https://i.ytimg.com/x.jpg", SOURCE_ITUNES, 422),
    (ITUNES_URL, SOURCE_UPLOAD, 422),
])
def test_from_url_rechaza_url_o_fuente_fuera_de_la_lista(api, url, source, status):
    c, _root, _storage = api
    r = c.post("/api/art/from-url", json={"target": SONG, "url": url,
                                          "source": source})
    assert r.status_code == status


def test_from_url_rechaza_respuesta_que_no_es_jpeg(api, monkeypatch):
    c, _root, _storage = api
    _mock_fetch(monkeypatch,
                lambda request: httpx.Response(200, content=b"<html>no</html>"))
    r = c.post("/api/art/from-url", json={"target": SONG, "url": YT_URL,
                                          "source": SOURCE_YOUTUBE})
    assert r.status_code == 422
    assert c.get("/api/art").json() == {"art": {}}


def test_from_url_rechaza_redireccion_fuera_de_la_lista(api, monkeypatch):
    c, _root, _storage = api

    def handler(request):
        return httpx.Response(302, headers={
            "Location": "https://evil.example/x.jpg"})

    _mock_fetch(monkeypatch, handler)
    r = c.post("/api/art/from-url", json={"target": SONG, "url": YT_URL,
                                          "source": SOURCE_YOUTUBE})
    assert r.status_code == 422


# --------------------------------------------------------------------- Drive
class _FakeTokens:
    def access_token(self) -> str:
        return "test-token"

    def invalidate(self) -> None:
        pass


def _device(fake, device_id, clock):
    from backend.app.cloud.drive import DriveStorage

    client = httpx.Client(transport=httpx.MockTransport(fake))
    return DriveStorage(_FakeTokens(), client, device_id, clock=clock,
                        sleep=lambda _s: None)


def test_drive_mezcla_imagenes_y_escribe_solo_su_archivo():
    from backend.app.cloud.base import ART_PREFIX, INDEX_TTL, SMALL_PREFIXES
    from fake_drive import FakeDrive

    assert ART_PREFIX in SMALL_PREFIXES
    fake = FakeDrive()
    now = [1000.0]
    a, b = _device(fake, "A", lambda: now[0]), _device(fake, "B", lambda: now[0])
    a.save_art(lambda book: book.upsert(_rec(SONG, updated_at=10.0)))
    now[0] += INDEX_TTL + 1
    assert {r.target for r in b.load_art().live()} == {SONG}

    b.save_art(lambda book: book.upsert(_rec(ALBUM, updated_at=15.0)))
    now[0] += INDEX_TTL + 1
    assert {r.target for r in a.load_art().live()} == {SONG, ALBUM}
    names = sorted(f["name"] for f in fake.files.values()
                   if f["name"].startswith(ART_PREFIX))
    assert names == ["art-A.json", "art-B.json"]


def test_drive_merge_en_empate_gana_el_tombstone():
    from backend.app.cloud.base import INDEX_TTL
    from fake_drive import FakeDrive

    fake = FakeDrive()
    now = [1000.0]
    a, b = _device(fake, "A", lambda: now[0]), _device(fake, "B", lambda: now[0])
    a.save_art(lambda book: book.upsert(_rec(updated_at=10.0)))
    now[0] += INDEX_TTL + 1
    b.load_art()  # ve la copia de A
    b.save_art(lambda book: book.remove(SONG, now=10.0))
    now[0] += INDEX_TTL + 1
    assert a.load_art().live() == []


def test_drive_no_pisa_su_archivo_ilegible():
    from backend.app.cloud.base import INDEX_TTL
    from fake_drive import FakeDrive

    fake = FakeDrive()
    now = [1000.0]
    a = _device(fake, "A", lambda: now[0])
    a.save_art(lambda book: book.upsert(_rec(updated_at=10.0)))
    own = next(fid for fid, f in fake.files.items()
               if f["name"] == "art-A.json")
    fake.files[own]["data"] = b"{roto"
    now[0] += INDEX_TTL + 1
    with pytest.raises(RuntimeError):
        a.save_art(lambda book: book.upsert(_rec(ALBUM, updated_at=20.0)))
    assert fake.files[own]["data"] == b"{roto"
