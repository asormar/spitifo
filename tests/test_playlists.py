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
from backend.app.storage import get_storage, set_storage
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


def test_round_trip_conserva_campos_desconocidos():
    """Un cliente viejo que reescribe el JSON no puede borrar lo que no
    entiende: las claves nuevas de otra version vuelven intactas."""
    data = json.dumps({"version": 1, "playlists": [{
        "id": "p1", "name": "Viaje", "keys": ["A/a.mp3"], "updated_at": 1.0,
        "deleted": False,
        "campo_nuevo": {"profundo": [1, 2, None]},
        "otro_mas": "tal cual",
    }]}, sort_keys=True, ensure_ascii=False).encode()
    book = PlaylistBook.from_bytes(data)
    again = PlaylistBook.from_bytes(book.to_bytes())

    assert again.to_bytes() == book.to_bytes() == data
    assert again.playlists["p1"].extra == {
        "campo_nuevo": {"profundo": [1, 2, None]}, "otro_mas": "tal cual"}


def test_round_trip_conserva_los_campos_aditivos_y_una_carpeta():
    data = json.dumps({"version": 1, "playlists": [{
        "id": "carpeta", "name": "Para viajar", "keys": ["viaje", "gym"],
        "updated_at": 2.0, "deleted": False, "is_folder": True,
        "description": "Listas para el tren", "cover_key": "A/foto.jpg",
    }]}, sort_keys=True, ensure_ascii=False).encode()
    again = PlaylistBook.from_bytes(PlaylistBook.from_bytes(data).to_bytes())
    p = again.playlists["carpeta"]

    assert (p.is_folder, p.keys) == (True, ["viaje", "gym"])
    assert p.description == "Listas para el tren"
    assert p.cover_key == "A/foto.jpg"
    assert again.to_bytes() == data


def test_una_playlist_sin_campos_nuevos_mantiene_sus_bytes():
    """El formato en disco de una playlist vieja no cambia ni un byte."""
    data = json.dumps({"version": 1, "playlists": [{
        "id": "p1", "name": "Viaje", "keys": ["A/a.mp3"],
        "updated_at": 1.0, "deleted": False,
    }]}, sort_keys=True, ensure_ascii=False).encode()
    assert PlaylistBook.from_bytes(data).to_bytes() == data


def test_un_campo_desconocido_no_puede_suplantar_un_campo_conocido():
    from backend.app.playlists import _playlist_to_dict

    p = _playlist("p1", "Real", ("A/a.mp3",), 1.0)
    p.extra = {"name": "Falsa", "keys": ["../fuera.mp3"], "color": "rojo"}
    d = _playlist_to_dict(p)
    assert d["name"] == "Real"
    assert d["keys"] == ["A/a.mp3"]
    assert d["color"] == "rojo"


def test_el_indice_de_claves_apunta_a_las_listas_vivas():
    book = PlaylistBook()
    book.upsert(_playlist("a", "A", ("A/x.mp3", "A/y.mp3"), 1.0))
    book.upsert(_playlist("b", "B", ("A/y.mp3",), 1.0))
    book.upsert(_playlist("c", "C", ("A/z.mp3",), 1.0, deleted=True))

    assert book.owners({"A/y.mp3"}) == {"a", "b"}
    assert book.owners({"A/x.mp3", "A/z.mp3"}) == {"a"}
    assert book.owners({"A/nada.mp3"}) == set()

    # Cambiar una lista reconstruye el indice; la clave vieja ya no apunta.
    book.upsert(_playlist("a", "A", ("A/z.mp3",), 2.0))
    assert book.owners({"A/x.mp3"}) == set()
    assert book.owners({"A/z.mp3"}) == {"a"}


def test_el_indice_incluye_la_portada():
    p = _playlist("a", "A", ("A/x.mp3",), 1.0)
    p.cover_key = "A/portada.jpg"
    book = PlaylistBook(playlists={"a": p})
    assert book.owners({"A/portada.jpg"}) == {"a"}


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


def test_validate_playlist_acepta_ids_de_canciones_guardadas():
    ids = ["yt:dQw4w9WgXcQ", "ia:olivia-1969/01 Olivia.mp3"]
    name, keys = validate_playlist("p1", "  guardadas  ", ids + [ids[0]])
    assert name == "guardadas"
    assert keys == ids


def test_validate_playlist_rechaza_un_id_de_cancion_invalido():
    with pytest.raises(ValueError):
        validate_playlist("p1", "X", ["yt:no-vale"])


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


def test_put_y_get_de_campos_aditivos_y_carpeta(api):
    r = api.put("/api/playlists/viaje", json={
        "name": "Viaje", "keys": ["A/a.mp3"],
        "description": "Para el tren", "cover_key": "A/a.jpg"})
    assert r.status_code == 200
    assert r.json()["description"] == "Para el tren"
    assert r.json()["cover_key"] == "A/a.jpg"

    r = api.put("/api/playlists/carpeta", json={
        "name": "Para viajar", "keys": ["viaje"], "is_folder": True})
    assert r.status_code == 200
    assert r.json()["is_folder"] is True

    by_id = {p["id"]: p for p in api.get("/api/playlists").json()["playlists"]}
    assert by_id["carpeta"]["keys"] == ["viaje"]
    # Una carpeta no pierde su descripcion al reescribirse.
    assert by_id["viaje"]["description"] == "Para el tren"


def test_put_de_carpeta_rechaza_claves_de_cancion_y_self(api):
    assert api.put("/api/playlists/carpeta", json={
        "name": "Carpeta", "keys": ["A/a.mp3"], "is_folder": True}).status_code == 422
    assert api.put("/api/playlists/carpeta", json={
        "name": "Carpeta", "keys": ["carpeta"], "is_folder": True}).status_code == 422


def test_put_con_descripcion_o_portada_invalidos_da_422(api):
    for campo, valor in (("description", 7), ("cover_key", "../fuera.jpg"),
                         ("folder_id", "con espacio"), ("is_folder", "sí")):
        r = api.put("/api/playlists/p1", json={
            "name": "X", "keys": [], campo: valor})
        assert r.status_code == 422, campo


def test_un_write_que_falla_no_pierde_la_playlist_del_usuario(api, tmp_path, monkeypatch):
    storage = get_storage()
    ruta = tmp_path / "lib" / ".spitifo" / "playlists.json"
    api.put("/api/playlists/p1", json={"name": "Viaje", "keys": ["A/a.mp3"]})
    antes = ruta.read_bytes()

    def romper(_book):
        raise OSError("disco lleno")

    monkeypatch.setattr(storage, "_write_playlists", romper)
    with pytest.raises(OSError):
        storage.save_playlist(lambda b: b.upsert(_playlist("nueva", "Nueva")))
    assert ruta.read_bytes() == antes  # el archivo del usuario sigue ahi

    monkeypatch.undo()
    assert [p["id"] for p in api.get("/api/playlists").json()["playlists"]] == ["p1"]


def test_re_put_despues_del_delete_la_revive(api):
    vieja = api.put("/api/playlists/p1", json={
        "name": "Uno", "keys": ["A/a.mp3"]}).json()
    assert api.delete("/api/playlists/p1").status_code == 204

    nueva = api.put("/api/playlists/p1", json={
        "name": "Dos", "keys": ["A/b.mp3"]}).json()
    assert nueva["updated_at"] > vieja["updated_at"]
    assert api.get("/api/playlists").json()["playlists"] == [nueva]
