"""`POST /api/prefetch` con Drive (falso) y con disco local.

La UI lo dispara al empezar un tema para adelantar el siguiente. Con Drive la
descarga arranca en background (202); con disco local no hay cache que llenar
(204). Todo OFFLINE sobre `tests/fake_drive.py`.
"""
from __future__ import annotations

import httpx
import pytest
from starlette.testclient import TestClient

from backend.app.cloud.drive import DriveStorage
from backend.app.main import create_app
from backend.app.storage import set_storage
from fake_drive import FakeDrive

CONTENIDO = bytes(range(256)) * 4
CLAVE = "Artista/Artista - Tema.mp3"


class Tokens:
    def __init__(self) -> None:
        self.revocado = False

    def access_token(self) -> str:
        if self.revocado:
            raise RuntimeError("google: el token quedo revocado")
        return "tok"

    def invalidate(self) -> None:
        pass


@pytest.fixture
def api(tmp_path):
    """Drive falso SIN cache: el endpoint solo despacha, no espera la descarga."""
    fake = FakeDrive()
    storage = DriveStorage(
        Tokens(), httpx.Client(transport=httpx.MockTransport(fake)),
        "dev", sleep=lambda _s: None)
    src = tmp_path / "src.mp3"
    src.write_bytes(CONTENIDO)
    storage.put_file(CLAVE, src)
    set_storage(storage)
    try:
        with TestClient(create_app()) as c:
            yield c, fake
    finally:
        set_storage(None)


def test_prefetch_con_drive_devuelve_202(api):
    c, _ = api
    r = c.post("/api/prefetch", json={"key": CLAVE})
    assert r.status_code == 202
    assert r.json() == {"key": CLAVE}


def test_prefetch_clave_inexistente_es_404(api):
    c, _ = api
    r = c.post("/api/prefetch", json={"key": "Artista/no-esta.mp3"})
    assert r.status_code == 404


def test_prefetch_clave_no_audio_es_400(api):
    c, _ = api
    r = c.post("/api/prefetch", json={"key": "Artista/notas.txt"})
    assert r.status_code == 400


def test_prefetch_sin_key_es_400(api):
    c, _ = api
    r = c.post("/api/prefetch", json={})
    assert r.status_code == 400


def test_prefetch_con_disco_local_devuelve_204(storage_temporal, tmp_path):
    """`LocalStorage` no tiene `prefetch` (ni cache): 204 sin hacer nada."""
    root = tmp_path / "lib"
    storage_temporal(root)
    (root / "A").mkdir(parents=True, exist_ok=True)
    (root / "A" / "x.mp3").write_bytes(CONTENIDO)

    with TestClient(create_app()) as c:
        r = c.post("/api/prefetch", json={"key": "A/x.mp3"})
        assert r.status_code == 204
