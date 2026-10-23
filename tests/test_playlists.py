"""Playlists (roadmap, sesion 19): modelo, validacion y API.

Todo OFFLINE: el modelo es puro (`backend/app/playlists.py`) y la API corre
sobre un `LocalStorage` en una carpeta temporal.
"""
from __future__ import annotations

import json

import pytest
from starlette.testclient import TestClient

from backend.app.main import create_app
from backend.app.playlists import (
    MAX_KEYS,
    Playlist,
    PlaylistBook,
    PlaylistFormatError,
    validate_playlist,
)
from backend.app.storage import set_storage
from backend.app.storage.local import LocalStorage


def _playlist(pid: str = "p1", name: str = "Viaje",
              keys: tuple[str, ...] = ("A/a.mp3",),
              updated_at: float = 1.0, deleted: bool = False) -> Playlist:
    return Playlist(id=pid, name=name, keys=list(keys),
                    updated_at=updated_at, deleted=deleted)


# --------------------------------------------------------------- serializacion
def test_round_trip_con_bytes_estables():
    book = PlaylistBook()
    book.upsert(_playlist("b", "Zeta", ("A/z.mp3",), 2.0))
    book.upsert(_playlist("a", "Alfa", ("A/a.mp3", "A/b.mp3"), 1.0))

    data = book.to_bytes()
    again = PlaylistBook.from_bytes(data)

    assert again.to_bytes() == data  # bytes estables
    assert set(again.playlists) == {"a", "b"}
    assert again.playlists["a"] == _playlist(
        "a", "Alfa", ("A/a.mp3", "A/b.mp3"), 1.0)
    # la lista va ordenada por id, para que el archivo sea comparable
    assert [p["id"] for p in json.loads(data)["playlists"]] == ["a", "b"]


def test_json_invalido_se_rechaza():
    with pytest.raises(PlaylistFormatError):
        PlaylistBook.from_bytes(b"{no es json")


def test_lo_que_no_es_un_objeto_se_rechaza():
    with pytest.raises(PlaylistFormatError):
        PlaylistBook.from_bytes(b"[]")


def test_version_desconocida_se_rechaza():
    data = json.dumps({"version": 2, "playlists": []}).encode()
    with pytest.raises(PlaylistFormatError):
        PlaylistBook.from_bytes(data)


def test_from_bytes_salta_las_entradas_mal_formadas():
    payload = {"version": 1, "playlists": [
        {"id": "ok", "name": "Bien", "keys": ["A/a.mp3"], "updated_at": 1},
        {"id": "", "name": "sin id", "keys": [], "updated_at": 1},
        {"id": "x" * 65, "name": "id largo", "keys": [], "updated_at": 1},
        {"id": "sin-nombre", "keys": [], "updated_at": 1},
        {"id": "sin-claves", "name": "x", "updated_at": 1},
        {"id": "fecha-mala", "name": "x", "keys": [], "updated_at": "ayer"},
        {"id": "claves-malas", "name": "x", "keys": [1, "A/b.mp3"],
         "updated_at": 1},
        "no es un dict",
    ]}
    book = PlaylistBook.from_bytes(json.dumps(payload).encode())

    assert set(book.playlists) == {"ok", "claves-malas"}
    # las claves que no son texto se descartan, las buenas se conservan
    assert book.playlists["claves-malas"].keys == ["A/b.mp3"]


# -------------------------------------------------------------- upsert/remove
def test_remove_escribe_tombstone_conservando_el_nombre():
    book = PlaylistBook()
    book.upsert(_playlist("p1", "Viaje", ("A/a.mp3",), 1.0))
    book.remove("p1", now=9.0)

    playlist = book.playlists["p1"]
    assert (playlist.deleted, playlist.keys) == (True, [])
    assert playlist.name == "Viaje"
    assert playlist.updated_at == 9.0
    assert book.live() == []


def test_remove_de_un_id_desconocido_igual_deja_tombstone():
    book = PlaylistBook()
    book.remove("nunca-existio", now=5.0)
    assert book.playlists["nunca-existio"].deleted is True
    assert book.playlists["nunca-existio"].updated_at == 5.0
    assert book.live() == []


# --------------------------------------------------------------------- merge
def test_merge_gana_el_mas_nuevo():
    viejo = PlaylistBook()
    viejo.upsert(_playlist("p1", "Vieja", ("A/a.mp3",), 10.0))
    nuevo = PlaylistBook()
    nuevo.upsert(_playlist("p1", "Nueva", ("A/b.mp3",), 20.0))

    assert viejo.merge(nuevo).playlists["p1"].name == "Nueva"


def test_merge_en_empate_conserva_el_propio():
    mio = PlaylistBook()
    mio.upsert(_playlist("p1", "Mia", (), 10.0))
    igual = PlaylistBook()
    igual.upsert(_playlist("p1", "Ajena", (), 10.0))

    assert mio.merge(igual).playlists["p1"].name == "Mia"


def test_merge_junta_los_ids_de_los_dos():
    a = PlaylistBook()
    a.upsert(_playlist("a", "A", (), 1.0))
    b = PlaylistBook()
    b.upsert(_playlist("b", "B", (), 1.0))
    assert set(a.merge(b).playlists) == {"a", "b"}


def test_merge_el_tombstone_nuevo_borra_la_copia_vieja():
    vivo = PlaylistBook()
    vivo.upsert(_playlist("p1", "Viaje", ("A/a.mp3",), 10.0))
    muerto = PlaylistBook()
    muerto.remove("p1", now=20.0)

    merged = vivo.merge(muerto)
    assert merged.playlists["p1"].deleted is True
    assert merged.live() == []


def test_merge_una_playlist_nueva_pesa_mas_que_el_tombstone_viejo():
    """Deshacer un borrado: re-guardar despues del tombstone la revive."""
    muerto = PlaylistBook()
    muerto.remove("p1", now=20.0)
    nueva = PlaylistBook()
    nueva.upsert(_playlist("p1", "De vuelta", ("A/a.mp3",), 30.0))

    merged = nueva.merge(muerto)
    assert merged.playlists["p1"].deleted is False
    assert [p.name for p in merged.live()] == ["De vuelta"]


# ---------------------------------------------------------------------- live
def test_live_ordena_por_nombre_sin_mayusculas_y_despues_por_id():
    book = PlaylistBook()
    for pid, name in (("z", "Zeta"), ("a", "alfa"), ("b", "Beta"),
                      ("c", "alfa")):
        book.upsert(_playlist(pid, name, (), 1.0))

    assert [p.id for p in book.live()] == ["a", "c", "b", "z"]


# ---------------------------------------------------------------- validacion
@pytest.mark.parametrize("pid", ["", "con espacio", "punto.mal", "x" * 65,
                                 "tilde-ñ"])
def test_validate_playlist_rechaza_ids_invalidos(pid):
    with pytest.raises(ValueError):
        validate_playlist(pid, "X", [])


@pytest.mark.parametrize("name", ["", "   ", "n" * 101])
def test_validate_playlist_rechaza_nombres_invalidos(name):
    with pytest.raises(ValueError):
        validate_playlist("p1", name, [])


def test_validate_playlist_recorta_y_dedupea_conservando_el_orden():
    name, keys = validate_playlist(
        "p1", "  Viaje  ", ["A/b.mp3", "A/a.mp3", "A/b.mp3"])
    assert name == "Viaje"
    assert keys == ["A/b.mp3", "A/a.mp3"]


def test_validate_playlist_rechaza_una_clave_invalida():
    with pytest.raises(ValueError):
        validate_playlist("p1", "X", ["../fuera.mp3"])


def test_validate_playlist_rechaza_claves_que_no_son_texto():
    with pytest.raises(ValueError):
        validate_playlist("p1", "X", ["A/a.mp3", 7])


def test_validate_playlist_rechaza_demasiadas_claves():
    claves = [f"A/{i}.mp3" for i in range(MAX_KEYS + 1)]
    with pytest.raises(ValueError):
        validate_playlist("p1", "X", claves)


def test_validate_playlist_acepta_el_limite_exacto():
    claves = [f"A/{i}.mp3" for i in range(MAX_KEYS)]
    name, out = validate_playlist("p1", "Grande", claves)
    assert name == "Grande"
    assert len(out) == MAX_KEYS


def test_next_updated_at_siempre_avanza():
    from backend.app.main import _next_updated_at

    assert _next_updated_at(None, 5.0) == 5.0
    # El reloj retrocedio: igual tiene que superar a lo guardado.
    assert _next_updated_at(_playlist(updated_at=9.0), 1.0) == 9.001


# ---------------------------------------------------------------------- API
@pytest.fixture
def api(tmp_path):
    """TestClient con una biblioteca temporal vacia (LocalStorage)."""
    root = tmp_path / "lib"
    root.mkdir()
    set_storage(LocalStorage(root))
    try:
        with TestClient(create_app()) as c:
            yield c
    finally:
        set_storage(None)


def test_get_playlists_arranca_vacio(api):
    r = api.get("/api/playlists")
    assert r.status_code == 200
    assert r.json() == {"playlists": []}


def test_put_y_get_devuelve_la_playlist(api):
    r = api.put("/api/playlists/viaje", json={
        "name": "  Viaje  ", "keys": ["A/a.mp3", "A/b.mp3", "A/a.mp3"]})
    assert r.status_code == 200
    saved = r.json()
    assert set(saved) == {"id", "name", "keys", "updated_at"}
    assert saved["id"] == "viaje"
    assert saved["name"] == "Viaje"
    assert saved["keys"] == ["A/a.mp3", "A/b.mp3"]
    assert saved["updated_at"] > 0

    r = api.get("/api/playlists")
    assert r.status_code == 200
    assert r.json()["playlists"] == [saved]


def test_get_ordena_por_nombre(api):
    for pid, name in (("zeta", "Zeta"), ("alfa", "alfa")):
        assert api.put(f"/api/playlists/{pid}",
                       json={"name": name, "keys": []}).status_code == 200
    assert [p["id"] for p in api.get("/api/playlists").json()["playlists"]] == \
        ["alfa", "zeta"]


@pytest.mark.parametrize("cuerpo", [
    {"name": "", "keys": []},
    {"name": "   ", "keys": []},
    {"name": "n" * 101, "keys": []},
    {"name": "X", "keys": "../fuera.mp3"},
    {"name": "X", "keys": ["../fuera.mp3"]},
    {"name": "X", "keys": ["A/a.mp3", 3]},
    {"name": "X"},
    {"keys": []},
])
def test_put_invalido_da_422(api, cuerpo):
    r = api.put("/api/playlists/p1", json=cuerpo)
    assert r.status_code == 422
    assert r.json()["detail"][0]["msg"]


def test_put_con_id_invalido_da_422(api):
    r = api.put("/api/playlists/punto.mal", json={"name": "X", "keys": []})
    assert r.status_code == 422


def test_delete_da_204_y_la_saca_de_la_lista(api):
    assert api.put("/api/playlists/p1",
                   json={"name": "Uno", "keys": ["A/a.mp3"]}).status_code == 200

    assert api.delete("/api/playlists/p1").status_code == 204
    assert api.get("/api/playlists").json() == {"playlists": []}
    # Borrar una que no existe tambien es 204 (idempotente).
    assert api.delete("/api/playlists/no-existe").status_code == 204


def test_re_put_despues_del_delete_la_revive(api):
    vieja = api.put("/api/playlists/p1", json={
        "name": "Uno", "keys": ["A/a.mp3"]}).json()
    assert api.delete("/api/playlists/p1").status_code == 204

    nueva = api.put("/api/playlists/p1", json={
        "name": "Dos", "keys": ["A/b.mp3"]}).json()
    assert nueva["updated_at"] > vieja["updated_at"]
    assert api.get("/api/playlists").json()["playlists"] == [nueva]
