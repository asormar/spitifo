"""Canciones guardadas (ADR 0004): modelo, validacion y API.

Todo OFFLINE: el modelo es puro (`backend/app/saved.py`), la API corre sobre un
`LocalStorage` en una carpeta temporal y la nube sobre el Drive falso.
"""
from __future__ import annotations

import json

import httpx
import pytest
from starlette.testclient import TestClient

from backend.app.main import create_app
from backend.app.saved import (
    MAX_SONGS,
    SavedBook,
    SavedFormatError,
    SavedSong,
    song_id,
    validate_saved_payload,
    validate_song_id,
)
from backend.app.storage import set_storage
from backend.app.storage.local import LocalStorage

YT = "yt:dQw4w9WgXcQ"
IA = "ia:olivia-1969/01 Olivia.mp3"


def _song(sid=YT, title="Tema", artist="Artista", *, album=None,
          duration=None, artwork_url=None, source="youtube",
          source_id="dQw4w9WgXcQ", itunes=None, file_key=None,
          added_at=1.0, updated_at=1.0, deleted=False) -> SavedSong:
    return SavedSong(id=sid, title=title, artist=artist, album=album,
                     duration=duration, artwork_url=artwork_url,
                     source=source, source_id=source_id,
                     itunes=itunes if itunes is not None else {},
                     file_key=file_key, added_at=added_at,
                     updated_at=updated_at, deleted=deleted)


def _ia_song(title="Archivo", **kw) -> SavedSong:
    return _song(IA, title, source="archive", source_id="olivia-1969/01 Olivia.mp3", **kw)


def _record(**kw):
    """Un registro de la API (sin fechas: las pone el servidor)."""
    out = {"id": YT, "title": "Tema", "artist": "Artista",
           "source": "youtube", "source_id": "dQw4w9WgXcQ"}
    out.update(kw)
    return out


# --------------------------------------------------------------------- ids
def test_song_id_y_validate():
    assert song_id("youtube", "dQw4w9WgXcQ") == YT
    assert song_id("archive", "olivia-1969/01 Olivia.mp3") == IA
    assert validate_song_id("ia:concierto_77/disco 2/03 Tema.flac")
    assert validate_song_id(YT) == YT
    assert validate_song_id(IA) == IA


@pytest.mark.parametrize("sid", ["", "yt:short", "yt:1234567890!",
                                 "ia:", "ia:" + "a" * 101 + "/x.mp3",
                                 "ia:olivia-1969", "ia:olivia-1969/",
                                 "ia:olivia-1969/../x.mp3",
                                 "ia:olivia-1969/a?b.mp3",
                                 "ia:https://archive.org/x.mp3",
                                 "x:dQw4w9WgXcQ", "dQw4w9WgXcQ",
                                 "yt:https://stream.example/x"])
def test_validate_song_id_rechaza_ids_invalidos(sid):
    with pytest.raises(ValueError):
        validate_song_id(sid)


@pytest.mark.parametrize("source, raw", [
    ("vimeo", "dQw4w9WgXcQ"), ("youtube", "short"),
    ("youtube", "https://stream.example/x"), ("archive", 123),
])
def test_song_id_rechaza_fuente_o_source_id_invalidos(source, raw):
    with pytest.raises(ValueError):
        song_id(source, raw)


def test_el_id_nunca_trae_una_url_que_vence():
    # El formato del id no admite `://`, `/` ni `?`, asi que una URL nunca
    # puede colarse como identidad estable.
    with pytest.raises(ValueError):
        validate_song_id("yt:dQw4w9WgXcQ?sig=abc")


# --------------------------------------------------------------- validacion
def test_payload_valido_devuelve_registros_limpios():
    recs = validate_saved_payload({"songs": [
        _record(duration=210, itunes={"track_id": 7}, file_key="A/t.mp3"),
        _record(id=IA, source="archive", source_id="olivia-1969/01 Olivia.mp3"),
    ]})
    assert recs[0]["duration"] == 210.0
    assert recs[0]["itunes"] == {"track_id": 7}
    assert recs[0]["source"] == "youtube" and recs[0]["source_id"] == "dQw4w9WgXcQ"
    assert recs[1]["source"] == "archive"
    assert "added_at" not in recs[0] and "deleted" not in recs[0]


@pytest.mark.parametrize("cuerpo", [
    "no es un objeto",
    {},
    {"songs": "no es una lista"},
    {"songs": [7]},
    {"songs": [_record(id="mala")]},
    {"songs": [_record(source="archive")]},  # id no coincide con la fuente
    {"songs": [_record(source_id="otra-cosa12")]},
    {"songs": [_record(title="t" * 301)]},
    {"songs": [_record(artist="a" * 301)]},
    {"songs": [_record(album="a" * 301)]},
    {"songs": [_record(artwork_url="u" * 2001)]},
    {"songs": [_record(file_key="../fuera.mp3")]},
    {"songs": [_record(itunes=7)]},
    {"songs": [_record(itunes={"track_id": "1"})]},
    {"songs": [_record(itunes={"desconocida": 1})]},
    {"songs": [_record(itunes={"track_id": True})]},
    {"songs": [_record(duration=True)]},
    {"songs": [_record(duration="210")]},
])
def test_payload_invalido(cuerpo):
    with pytest.raises(ValueError):
        validate_saved_payload(cuerpo)


def _many(n: int) -> dict:
    return {"songs": [_record(id=f"yt:{i:011d}", source_id=f"{i:011d}")
                      for i in range(n)]}


def test_payload_rechaza_demasiadas_canciones():
    with pytest.raises(ValueError):
        validate_saved_payload(_many(MAX_SONGS + 1))


def test_payload_acepta_el_limite_exacto():
    assert len(validate_saved_payload(_many(MAX_SONGS))) == MAX_SONGS


# ------------------------------------------------------- serializacion y merge
def test_round_trip_con_bytes_estables():
    book = SavedBook()
    book.upsert(_ia_song("Zeta", added_at=2.0, updated_at=2.0))
    book.upsert(_song(YT, "Alfa", added_at=1.0, updated_at=1.0,
                      itunes={"track_id": 3, "disc_no": 1}, file_key="A/t.mp3"))

    data = book.to_bytes()
    again = SavedBook.from_bytes(data)

    assert again.to_bytes() == data
    assert set(again.songs) == {YT, IA}
    assert again.songs[YT].itunes == {"track_id": 3, "disc_no": 1}
    assert again.songs[YT].file_key == "A/t.mp3"
    assert [s["id"] for s in json.loads(data)["songs"]] == sorted([YT, IA])


@pytest.mark.parametrize("data", [b"{no es json", b"[]",
                                  json.dumps({"version": 2, "songs": []}).encode()])
def test_bytes_malos_se_rechazan(data):
    with pytest.raises(SavedFormatError):
        SavedBook.from_bytes(data)


def test_from_bytes_salta_entradas_mal_formadas():
    payload = {"version": 1, "songs": [
        {"id": YT, "title": "Bien", "artist": "A", "source": "youtube",
         "source_id": "dQw4w9WgXcQ", "added_at": 1, "updated_at": 1},
        {"id": "mala", "title": "No", "artist": "A", "source": "youtube",
         "source_id": "dQw4w9WgXcQ", "added_at": 1, "updated_at": 1},
        {"id": YT, "title": "Sin fuente", "artist": "A", "added_at": 1,
         "updated_at": 1},
        "no es un dict",
    ]}
    assert set(SavedBook.from_bytes(json.dumps(payload).encode()).songs) == {YT}


# -------------------------------------------------------------- upsert/remove
def test_live_ordena_por_added_at_nuevo_primero():
    book = SavedBook()
    book.upsert(_song(YT, "Vieja", added_at=1.0))
    book.upsert(_ia_song("Nueva", added_at=9.0))
    assert [s.title for s in book.live()] == ["Nueva", "Vieja"]


def test_remove_escribe_tombstone_y_lo_salta_live():
    book = SavedBook()
    book.upsert(_song(YT, added_at=1.0, updated_at=1.0))
    book.remove(YT, now=9.0)
    assert book.songs[YT].deleted is True
    assert book.songs[YT].title == "Tema"  # se conserva
    assert book.songs[YT].updated_at == 9.0
    assert book.live() == []


def test_remove_de_un_id_desconocido_igual_deja_tombstone_valido():
    book = SavedBook()
    book.remove(IA, now=5.0)
    tomb = book.songs[IA]
    assert (tomb.deleted, tomb.source, tomb.source_id) == (
        True, "archive", "olivia-1969/01 Olivia.mp3")
    assert SavedBook.from_bytes(book.to_bytes()).songs[IA] == tomb


# --------------------------------------------------------------------- merge
def test_merge_gana_el_mas_nuevo():
    viejo, nuevo = SavedBook(), SavedBook()
    viejo.upsert(_song(YT, "Vieja", updated_at=10.0))
    nuevo.upsert(_song(YT, "Nueva", updated_at=20.0))
    assert viejo.merge(nuevo).songs[YT].title == "Nueva"


def test_merge_en_empate_gana_el_tombstone_en_los_dos_sentidos():
    vivo, muerto = SavedBook(), SavedBook()
    vivo.upsert(_song(YT, updated_at=10.0))
    muerto.remove(YT, now=10.0)
    assert vivo.merge(muerto).songs[YT].deleted is True
    assert muerto.merge(vivo).songs[YT].deleted is True
    # Dos tumbas en empate tambien quedan como tumba.
    assert muerto.merge(SavedBook(songs=dict(muerto.songs))).songs[YT].deleted


def test_merge_junta_ids_y_revive_un_tombstone_viejo():
    a, b = SavedBook(), SavedBook()
    a.upsert(_song(YT, updated_at=10.0))
    b.remove(IA, now=10.0)
    b.upsert(_song(YT, "De vuelta", updated_at=20.0))
    merged = a.merge(b)
    assert {s.id for s in merged.live()} == {YT}
    assert merged.songs[IA].deleted is True


# ---------------------------------------------------------------------- API
@pytest.fixture
def api(tmp_path):
    """TestClient con una biblioteca temporal vacia (LocalStorage)."""
    root = tmp_path / "lib"
    root.mkdir()
    set_storage(LocalStorage(root))
    try:
        with TestClient(create_app()) as c:
            yield c, root
    finally:
        set_storage(None)


def test_get_saved_arranca_vacio(api):
    c, _root = api
    assert c.get("/api/saved").json() == {"songs": []}


def test_put_y_get_devuelve_la_cancion(api):
    c, _root = api
    r = c.put("/api/saved", json={"songs": [_record(
        itunes={"track_id": 7}, file_key="A/t.mp3")]})
    assert r.status_code == 200
    saved = r.json()["songs"][0]
    assert set(saved) == {"id", "title", "artist", "album", "duration",
                          "artwork_url", "source", "source_id", "itunes",
                          "file_key", "added_at", "updated_at"}
    assert saved["id"] == YT and saved["itunes"] == {"track_id": 7}
    assert saved["file_key"] == "A/t.mp3"
    assert saved["added_at"] > 0 and saved["updated_at"] >= saved["added_at"]
    assert c.get("/api/saved").json()["songs"] == [saved]


def test_reput_conserva_added_at_y_avanza_updated_at(api):
    c, _root = api
    first = c.put("/api/saved", json={"songs": [_record(title="Uno")]}).json()["songs"][0]
    second = c.put("/api/saved", json={"songs": [_record(title="Dos")]}).json()["songs"][0]
    assert second["title"] == "Dos"
    assert second["added_at"] == first["added_at"]
    assert second["updated_at"] > first["updated_at"]


def test_remove_y_reput_lo_reviven(api):
    c, _root = api
    c.put("/api/saved", json={"songs": [_record()]})
    assert c.post("/api/saved/remove", json={"ids": [YT]}).status_code == 200
    assert c.get("/api/saved").json() == {"songs": []}
    assert c.post("/api/saved/remove", json={"ids": ["no-existe"]}).status_code == 422
    revived = c.put("/api/saved", json={"songs": [_record(title="Otra")]}).json()["songs"][0]
    assert revived["title"] == "Otra"
    assert c.get("/api/saved").json()["songs"] == [revived]


def test_volver_a_guardar_algo_quitado_cuenta_como_nuevo(api, monkeypatch):
    """Vuelve arriba de "Añadido hace poco": no conserva la fecha vieja."""
    c, _root = api
    first = c.put("/api/saved", json={"songs": [_record()]}).json()["songs"][0]
    c.post("/api/saved/remove", json={"ids": [YT]})
    import backend.app.main as main_mod
    monkeypatch.setattr(main_mod.time, "time", lambda: first["added_at"] + 100)
    again = c.put("/api/saved", json={"songs": [_record()]}).json()["songs"][0]
    assert again["added_at"] == first["added_at"] + 100


@pytest.mark.parametrize("cuerpo", [
    {},
    {"songs": [dict(_record(), title="t" * 301)]},
    {"songs": [dict(_record(), source="archive")]},
    {"songs": [dict(_record(), file_key="../fuera.mp3")]},
    {"songs": [dict(_record(), itunes={"x": 1})]},
])
def test_put_invalido_da_422(api, cuerpo):
    c, _root = api
    r = c.put("/api/saved", json=cuerpo)
    assert r.status_code == 422
    assert r.json()["detail"][0]["msg"]


def test_remove_invalido_da_422(api):
    c, _root = api
    assert c.post("/api/saved/remove", json={"ids": "no lista"}).status_code == 422
    assert c.post("/api/saved/remove", json={"ids": [YT, "mala"]}).status_code == 422


def test_archivo_local_es_oculto_y_ilegible_no_se_pisa(api):
    c, root = api
    c.put("/api/saved", json={"songs": [_record()]})
    path = root / ".spitifo" / "library.json"
    assert path.is_file()
    assert c.get("/api/library").json()["count"] == 0

    path.write_bytes(b"{roto")
    assert c.get("/api/saved").json() == {"songs": []}
    # Guardar NO pisa lo que no se pudo leer (TestClient propaga el error).
    with pytest.raises(RuntimeError):
        c.put("/api/saved", json={"songs": [_record()]})
    assert path.read_bytes() == b"{roto"


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


def _library_files(fake):
    return {f["name"]: f for f in fake.files.values()
            if f["name"].startswith("library-")}


def _uploads(fake) -> int:
    return sum(1 for method, path in fake.calls
               if method in ("POST", "PATCH") and path.startswith("/upload/"))


def test_drive_dos_dispositivos_mezclan_sus_canciones():
    from backend.app.cloud.base import INDEX_TTL
    from fake_drive import FakeDrive

    fake = FakeDrive()
    now = [1000.0]
    a, b = _device(fake, "A", lambda: now[0]), _device(fake, "B", lambda: now[0])
    a.save_saved(lambda bk: bk.upsert(_song(YT, "De A", added_at=10.0, updated_at=10.0)))
    now[0] += INDEX_TTL + 1
    assert [s.title for s in b.load_saved().live()] == ["De A"]

    b.save_saved(lambda bk: bk.upsert(_ia_song("De B", added_at=15.0, updated_at=15.0)))
    now[0] += INDEX_TTL + 1
    assert {s.id for s in a.load_saved().live()} == {YT, IA}
    assert sorted(_library_files(fake)) == ["library-A.json", "library-B.json"]


def test_drive_escribe_solo_su_archivo_y_una_sola_subida():
    from backend.app.cloud.base import INDEX_TTL
    from fake_drive import FakeDrive

    fake = FakeDrive()
    now = [1000.0]
    a, b = _device(fake, "A", lambda: now[0]), _device(fake, "B", lambda: now[0])
    a.save_saved(lambda bk: bk.upsert(_song(YT, added_at=10.0, updated_at=10.0)))
    antes = _library_files(fake)["library-A.json"]

    now[0] += INDEX_TTL + 1
    b.save_saved(lambda bk: bk.upsert(_ia_song(added_at=15.0, updated_at=15.0)))
    despues = _library_files(fake)
    assert set(despues) == {"library-A.json", "library-B.json"}
    assert (despues["library-A.json"]["data"],
            despues["library-A.json"]["version"]) == (antes["data"], antes["version"])

    fake.reset_calls()
    b.save_saved(lambda bk: bk.upsert(_ia_song("Otra", added_at=16.0, updated_at=16.0)))
    assert _uploads(fake) == 1
    assert _library_files(fake)["library-A.json"]["data"] == antes["data"]


def test_drive_merge_en_empate_gana_el_tombstone():
    from backend.app.cloud.base import INDEX_TTL
    from fake_drive import FakeDrive

    fake = FakeDrive()
    now = [1000.0]
    a, b = _device(fake, "A", lambda: now[0]), _device(fake, "B", lambda: now[0])
    a.save_saved(lambda bk: bk.upsert(_song(YT, added_at=10.0, updated_at=10.0)))
    now[0] += INDEX_TTL + 1
    b.load_saved()  # ve la copia de A
    b.save_saved(lambda bk: bk.remove(YT, now=10.0))  # tombstone en empate
    now[0] += INDEX_TTL + 1
    assert a.load_saved().live() == []
