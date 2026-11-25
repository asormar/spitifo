"""El primer `/api/library` no espera al escaneo (P-cold-start-1).

Con una biblioteca nueva el escaneo puede quedar frenado por el primer analisis
del antivirus. La respuesta sale de la instantanea persistida, se marca como
pendiente y el frontend pide de nuevo; una vez escaneada, la firma coincide y la
respuesta es la de siempre, con su ETag.
"""
from __future__ import annotations

import threading
import time

import pytest
from starlette.testclient import TestClient

from backend.app import main
from backend.app.storage import set_storage
from backend.app.storage.local import LocalStorage


@pytest.fixture
def library(tmp_path):
    root = tmp_path / "lib"
    root.mkdir()
    (root / "A").mkdir()
    (root / "A" / "a.mp3").write_bytes(b"x" * 8)
    storage = LocalStorage(root, device_id="d1")
    set_storage(storage)
    try:
        yield root
    finally:
        set_storage(None)


def test_el_primer_get_no_espera_al_escaneo(library, monkeypatch):
    real = main.library_scan
    escaneo = threading.Event()

    def lento():
        escaneo.set()
        time.sleep(0.8)
        return real()

    monkeypatch.setattr(main, "library_scan", lento)
    monkeypatch.setattr(main, "LIBRARY_SNAPSHOT_WAIT_S", 0.05)

    with TestClient(main.create_app()) as c:
        t0 = time.monotonic()
        primera = c.get("/api/library")
        elapsed = time.monotonic() - t0

        assert escaneo.is_set()
        assert elapsed < 0.5, "la UI no puede esperar al escaneo inicial"
        assert primera.headers.get(main.LIBRARY_PENDING_HEADER) == "1"
        assert primera.json()["count"] == 0

        # Cuando el escaneo de fondo termina, la misma URL da la lista real y
        # ya no va marcada como pendiente.
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            segunda = c.get("/api/library")
            if segunda.json()["count"] == 1:
                break
            time.sleep(0.05)
        assert segunda.json()["count"] == 1
        assert main.LIBRARY_PENDING_HEADER not in segunda.headers


def test_la_instantanea_sobrevive_al_reinicio(library, monkeypatch):
    with TestClient(main.create_app()) as c:
        assert c.get("/api/library").json()["count"] == 1

    # Otro arranque sobre la MISMA biblioteca: la firma coincide con la de la
    # instantanea guardada, asi que no hace falta escanear para responder.
    def no_escanear():
        raise AssertionError("el arranque tibio no debia escanear")

    monkeypatch.setattr(main, "library_scan", no_escanear)
    with TestClient(main.create_app()) as c:
        respuesta = c.get("/api/library")
        assert respuesta.json()["count"] == 1
        assert main.LIBRARY_PENDING_HEADER not in respuesta.headers


def test_un_cambio_en_disco_invalida_la_instantanea(library):
    with TestClient(main.create_app()) as c:
        assert c.get("/api/library").json()["count"] == 1
        (library / "A" / "b.mp3").write_bytes(b"y" * 8)
        assert c.get("/api/library").json()["count"] == 2
