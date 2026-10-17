"""Tests OFFLINE del indice de la biblioteca (backend/app/cloud/library_index.py)."""
from __future__ import annotations

import json
from dataclasses import asdict

import pytest

from backend.app.cloud.library_index import (
    IndexEntry,
    IndexFormatError,
    LibraryIndex,
    PreconditionFailed,
    update_index,
)


def _entry(key: str = "A/A - x.mp3", updated_at: float = 1.0,
           deleted: bool = False, **extra) -> IndexEntry:
    base = dict(
        key=key, remote_id="rid-" + key, revision="rev1", title="x",
        artist="A", album="Alb", duration=12.5, size=100, format="mp3",
        updated_at=updated_at, deleted=deleted)
    base.update(extra)
    return IndexEntry(**base)


# --------------------------------------------------------------- serializacion
def test_round_trip_bytes_estables():
    index = LibraryIndex()
    index.upsert(_entry("B/B - y.mp3", 2.0))
    index.upsert(_entry("A/A - x.mp3", 1.0))

    data = index.to_bytes()
    again = LibraryIndex.from_bytes(data)

    assert again.to_bytes() == data  # bytes estables
    assert set(again.entries) == {"A/A - x.mp3", "B/B - y.mp3"}
    assert again.entries["A/A - x.mp3"] == _entry("A/A - x.mp3", 1.0)


def test_version_desconocida_se_rechaza():
    data = json.dumps({"version": 2, "entries": []}).encode()
    with pytest.raises(IndexFormatError):
        LibraryIndex.from_bytes(data)


def test_json_invalido_se_rechaza():
    with pytest.raises(IndexFormatError):
        LibraryIndex.from_bytes(b"{no es json")


def test_claves_invalidas_se_saltan():
    payload = {"version": 1, "entries": [
        asdict(_entry("A/A - x.mp3")),
        {"key": "../escape.mp3", "updated_at": 1},
        {"key": "A/", "updated_at": 1},
        {"no_tiene_key": True},
    ]}
    index = LibraryIndex.from_bytes(json.dumps(payload).encode())
    assert set(index.entries) == {"A/A - x.mp3"}


def test_remove_escribe_tombstone():
    index = LibraryIndex()
    index.upsert(_entry("A/A - x.mp3", 1.0))
    index.remove("A/A - x.mp3", now=9.0)

    entry = index.entries["A/A - x.mp3"]
    assert entry.deleted is True
    assert entry.updated_at == 9.0
    assert index.live() == []


def test_remove_de_una_clave_desconocida_igual_deja_tombstone():
    index = LibraryIndex()
    index.remove("Z/Z - z.mp3", now=5.0)
    assert index.entries["Z/Z - z.mp3"].deleted is True


# --------------------------------------------------------------------- merge
def test_merge_gana_el_mas_nuevo():
    viejo = LibraryIndex()
    viejo.upsert(_entry("k.mp3", 10.0, title="viejo"))
    nuevo = LibraryIndex()
    nuevo.upsert(_entry("k.mp3", 20.0, title="nuevo"))

    assert viejo.merge(nuevo).entries["k.mp3"].title == "nuevo"


def test_merge_en_empate_conserva_el_propio():
    mio = LibraryIndex()
    mio.upsert(_entry("k.mp3", 10.0, title="mio"))
    igual = LibraryIndex()
    igual.upsert(_entry("k.mp3", 10.0, title="otro"))

    assert mio.merge(igual).entries["k.mp3"].title == "mio"


def test_merge_junta_claves_de_los_dos():
    a = LibraryIndex()
    a.upsert(_entry("a.mp3", 1.0))
    b = LibraryIndex()
    b.upsert(_entry("b.mp3", 1.0))
    assert set(a.merge(b).entries) == {"a.mp3", "b.mp3"}


def test_merge_respeta_los_tombstones():
    vivo = LibraryIndex()
    vivo.upsert(_entry("k.mp3", 10.0))
    muerto = LibraryIndex()
    muerto.remove("k.mp3", now=20.0)

    merged = vivo.merge(muerto)
    assert merged.entries["k.mp3"].deleted is True
    assert merged.live() == []

    # Un tombstone viejo no resucita nada por delante de una edicion nueva.
    mas_nuevo = LibraryIndex()
    mas_nuevo.upsert(_entry("k.mp3", 30.0))
    assert mas_nuevo.merge(muerto).entries["k.mp3"].deleted is False


# ---------------------------------------------------------------- update_index
def test_update_index_escribe_sin_conflicto():
    index = LibraryIndex()
    index.upsert(_entry("k.mp3", 1.0))
    estado = {"body": index.to_bytes(), "rev": "r1"}

    def read():
        return LibraryIndex.from_bytes(estado["body"]), estado["rev"]

    def write(body: bytes, if_match: str | None) -> str:
        estado["body"] = body
        return "r2"

    final, rev = update_index(read, write, lambda i: None, attempts=1)
    assert rev == "r2"
    assert set(final.entries) == {"k.mp3"}


def test_update_index_crea_el_indice_si_no_existe():
    def read():
        return None, None

    def write(body: bytes, if_match: str | None) -> str:
        assert if_match is None
        return "r1"

    final, rev = update_index(read, write,
                              lambda i: i.upsert(_entry("k.mp3")), attempts=1)
    assert rev == "r1"
    assert "k.mp3" in final.entries


def test_update_index_reintenta_sobre_la_copia_fresca():
    otra = _entry("B/B - y.mp3", 5.0)
    estado = {"body": LibraryIndex().to_bytes(), "rev": "r1"}
    intentos = {"n": 0}

    def read():
        return LibraryIndex.from_bytes(estado["body"]), estado["rev"]

    def write(body: bytes, if_match: str | None) -> str:
        intentos["n"] += 1
        if intentos["n"] == 1:
            # Otro dispositivo gano la carrera: el indice remoto cambio.
            ajeno = LibraryIndex.from_bytes(estado["body"])
            ajeno.upsert(otra)
            estado["body"] = ajeno.to_bytes()
            estado["rev"] = "r2"
            raise PreconditionFailed()
        estado["body"] = body
        return "r3"

    def change(index: LibraryIndex) -> None:
        index.upsert(_entry("A/A - x.mp3", 1.0))

    final, rev = update_index(read, write, change, attempts=5)

    assert rev == "r3"
    assert intentos["n"] == 2
    # El cambio se aplico SOBRE la copia fresca: conviven las dos pistas.
    assert set(final.entries) == {"A/A - x.mp3", "B/B - y.mp3"}


def test_update_index_se_rinde_tras_los_intentos():
    llamadas = {"n": 0}

    def read():
        return LibraryIndex(), "r1"

    def write(body: bytes, if_match: str | None) -> str:
        llamadas["n"] += 1
        raise PreconditionFailed()

    with pytest.raises(PreconditionFailed):
        update_index(read, write, lambda i: i.upsert(_entry("k.mp3")),
                     attempts=3)
    assert llamadas["n"] == 3
