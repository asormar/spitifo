"""El primer GET /api/discover de un arranque, sobre Drive (`tests/fake_drive.py`).

Un "arranque" es un `DriveStorage` nuevo sobre la copia local que dejo el
proceso anterior: tiene los ids de carpeta y los bytes, pero cada prefijo de
archivos chicos se vuelve a listar. Estos tests cuentan esos `files.list`.
"""
from __future__ import annotations

import os
import threading
import time

import httpx
import pytest
from starlette.testclient import TestClient

from backend.app import main
from backend.app.artistinfo import MATCH_RULE
from backend.app.cloud.drive import DriveStorage
from backend.app.cloud.snapshot import SmallFileSnapshot
from backend.app.main import create_app
from backend.app.storage import set_storage
from fake_drive import FakeDrive

#: Lo que lista un GET frio: el indice (la biblioteca), las fichas, los
#: descartes y, en un solo `q`, los meses y agregados de escucha.
COLD_LISTINGS = 4


class _Tokens:
    def access_token(self) -> str:
        return "token-de-prueba"

    def invalidate(self) -> None:
        pass


class FakeEnricher:
    """Doble sin hilo ni fichas propias: Discover lee las del storage."""

    def ensure_started(self) -> None:
        pass

    def status(self) -> dict:
        return {"done": 0, "total": 0, "running": False, "offline": False}


def _storage(fake, snap_dir) -> DriveStorage:
    client = httpx.Client(transport=httpx.MockTransport(fake))
    return DriveStorage(_Tokens(), client, "devA",
                        snapshot=SmallFileSnapshot(snap_dir),
                        sleep=lambda s: None)


def _record(name: str, **extra) -> dict:
    return {"name": name, "mbid": f"m-{name}", "genres": [], "similar": [],
            "fetched_at": time.time(), "status": "ok", "rule": MATCH_RULE,
            **extra}


@pytest.fixture
def launch(tmp_path, monkeypatch):
    """Biblioteca sembrada por un proceso anterior; devuelve el Drive y el
    storage del arranque nuevo, ya activo y sin requests contadas."""
    fake = FakeDrive()
    snap = tmp_path / "snap"
    before = _storage(fake, snap)
    src = tmp_path / "src.mp3"
    src.write_bytes(os.urandom(64))
    before.put_file("Alfa/Alfa - Uno.mp3", src)
    before.save_artistinfo({
        "alfa": _record("Alfa", genres=[["rock", 3]], similar=[
            {"name": "X", "mbid": "m-X", "score": 1.0},
            {"name": "Y", "mbid": "m-Y", "score": 0.5}]),
        "x": _record("X", genres=[["indie", 2]]),
        "y": _record("Y", genres=[["punk", 1]]),
    })
    before.dismiss_artist("Y")
    before.append_listens([{"t": int(time.time()), "k": "Alfa/Alfa - Uno.mp3",
                            "d": 120000, "l": 60000, "p": 60000, "r": "end",
                            "o": "play"}])

    storage = _storage(fake, snap)
    set_storage(storage)
    fake.reset_calls()
    try:
        yield fake, storage
    finally:
        set_storage(None)


def _artists(body: dict) -> list[str]:
    return [artist["name"] for artist in body["artists"]]


def test_el_get_frio_lista_cada_prefijo_una_sola_vez(launch, monkeypatch):
    fake, _ = launch
    monkeypatch.setattr(main, "_enricher", FakeEnricher())
    with TestClient(create_app()) as client:
        body = client.get("/api/discover").json()

    assert _artists(body) == ["X"]  # Y esta descartado
    assert len(fake.list_queries) == COLD_LISTINGS
    listed = " | ".join(fake.list_queries)
    for prefix in ("index-", "artistinfo-", "discover-", "listens-",
                   "listenagg-"):
        assert listed.count(f"'{prefix}'") == 1, prefix
    # Los meses y los agregados de escucha salen del mismo listado.
    assert any("'listens-'" in q and "'listenagg-'" in q
               for q in fake.list_queries)


def test_los_listados_del_get_frio_van_en_paralelo(launch, monkeypatch):
    fake, _ = launch
    monkeypatch.setattr(main, "_enricher", FakeEnricher())
    # Cada listado espera a los demas: en serie, el primero no pasa nunca.
    barrier = threading.Barrier(COLD_LISTINGS, timeout=5)
    fake.on_list = lambda q: barrier.wait()
    with TestClient(create_app()) as client:
        response = client.get("/api/discover")

    assert response.status_code == 200
    assert _artists(response.json()) == ["X"]


def test_el_listado_sigue_las_paginas_de_drive(launch):
    fake, storage = launch
    fake.page_size_cap = 1
    storage.append_listens([{"t": int(time.time()) - 40 * 86400,
                             "k": "Alfa/Alfa - Uno.mp3", "d": 120000,
                             "l": 60000, "p": 60000, "r": "end", "o": "play"}])
    fake.reset_calls()

    names = {name for _, name in storage._listens_list()}

    # Dos meses y el agregado: tres paginas de un archivo, un solo `q`.
    assert len(names) == 3
    assert len(fake.list_queries) == 3
    assert len(set(fake.list_queries)) == 1
