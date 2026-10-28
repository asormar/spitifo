"""El primer GET /api/discover de un arranque, sobre Drive (`tests/fake_drive.py`).

Un "arranque" es un `DriveStorage` nuevo sobre la copia local que dejo el
proceso anterior: tiene los ids de carpeta y los bytes, pero cada prefijo de
archivos chicos se vuelve a listar. Estos tests cuentan esos `files.list`.
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

from backend.app.artistinfo import MATCH_RULE
from backend.app.cloud.drive import DriveStorage
from backend.app.cloud.snapshot import SmallFileSnapshot
from backend.app.storage import set_storage
from fake_drive import FakeDrive

class _Tokens:
    def access_token(self) -> str:
        return "token-de-prueba"

    def invalidate(self) -> None:
        pass


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
