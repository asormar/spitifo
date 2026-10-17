"""`/api/audio` y `/api/library` con la biblioteca en Google Drive (falso).

Lo mismo que test_api_audio_range.py pero con `DriveStorage`: el backend hace
de proxy, agrega el token y reenvia el `Range` (ADR 0002, seccion 5). Mas los
errores del conector traducidos a respuestas que la UI entiende (seccion 8).
Todo OFFLINE sobre `tests/fake_drive.py`.
"""
from __future__ import annotations

import httpx
import pytest
from starlette.testclient import TestClient

from backend.app.cloud.drive import DriveStorage
from backend.app.cloud.tokens import ReconnectRequired
from backend.app.main import create_app
from backend.app.storage import set_storage
from fake_drive import FakeDrive

CONTENIDO = bytes(range(256)) * 4  # 1 KiB, cada offset se distingue


class Tokens:
    def __init__(self) -> None:
        self.revocado = False

    def access_token(self) -> str:
        if self.revocado:
            raise ReconnectRequired("google: el token quedo revocado")
        return "tok"

    def invalidate(self) -> None:
        pass


@pytest.fixture
def api(tmp_path):
    fake = FakeDrive()
    tokens = Tokens()
    storage = DriveStorage(tokens, httpx.Client(transport=httpx.MockTransport(fake)),
                           "dev", sleep=lambda s: None)
    src = tmp_path / "src.mp3"
    src.write_bytes(CONTENIDO)
    storage.put_file("Artista/Artista - Tema.mp3", src)
    set_storage(storage)
    try:
        with TestClient(create_app()) as c:
            yield c, fake, tokens
    finally:
        set_storage(None)


def test_library_lista_desde_el_indice(api):
    c, _, _ = api
    r = c.get("/api/library")
    assert r.status_code == 200
    body = r.json()
    assert body["library"] == "Google Drive: Spitifo"
    assert [f["key"] for f in body["files"]] == ["Artista/Artista - Tema.mp3"]


def test_audio_completo(api):
    c, _, _ = api
    r = c.get("/api/audio", params={"key": "Artista/Artista - Tema.mp3"})
    assert r.status_code == 200
    assert r.content == CONTENIDO
    assert r.headers["content-length"] == str(len(CONTENIDO))


def test_audio_rango_reenvia_el_range_a_drive(api):
    c, fake, _ = api
    fake.reset_calls()
    r = c.get("/api/audio", params={"key": "Artista/Artista - Tema.mp3"},
              headers={"Range": "bytes=500-599"})
    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes 500-599/{len(CONTENIDO)}"
    assert r.content == CONTENIDO[500:600]
    # Una sola request a Drive: el stat salio del indice en memoria.
    assert len(fake.calls) == 1


def test_audio_clave_inexistente_es_404(api):
    c, _, _ = api
    r = c.get("/api/audio", params={"key": "Artista/no-esta.mp3"})
    assert r.status_code == 404


def test_token_revocado_pide_reconectar(api):
    c, _, tokens = api
    tokens.revocado = True
    r = c.get("/api/audio", params={"key": "Artista/Artista - Tema.mp3"},
              headers={"Range": "bytes=0-9"})
    assert r.status_code == 503
    assert r.json()["code"] == "reconnect_required"


def test_drive_caido_es_502(api):
    c, fake, _ = api

    def caido(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sin red", request=request)

    fake.fail_with = caido
    r = c.get("/api/audio", params={"key": "Artista/Artista - Tema.mp3"},
              headers={"Range": "bytes=0-9"})
    assert r.status_code == 502
    assert r.json()["code"] == "storage_unreachable"
