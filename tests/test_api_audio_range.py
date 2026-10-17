"""`/api/audio` con claves relativas y soporte de `Range` (206/416).

Todo OFFLINE: se instala un `LocalStorage` sobre una carpeta temporal y se
planta el archivo ahi. El endpoint ya no acepta rutas del host: recibe una clave
relativa a la raiz de la biblioteca (docs/adr/0002-user-owned-storage.md).
"""
from __future__ import annotations

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from backend.app.main import create_app
from backend.app.storage import set_storage
from backend.app.storage.local import LocalStorage

CONTENIDO = bytes(range(256))  # 256 bytes, cada uno distinto: se ve cualquier offset


@pytest.fixture
def api(tmp_path):
    """TestClient con una biblioteca temporal vacia; devuelve (cliente, raiz)."""
    root = tmp_path / "lib"
    root.mkdir()
    set_storage(LocalStorage(root))
    try:
        with TestClient(create_app()) as c:
            yield c, root
    finally:
        set_storage(None)  # vuelve al adapter de siempre


def _plantar(root: Path, key: str, data: bytes = CONTENIDO) -> None:
    p = root / key
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)


# ------------------------------------------------------------------ 200 completo
def test_audio_completo_da_200_con_accept_ranges(api):
    c, root = api
    _plantar(root, "Artista/Artista - Tema.mp3")
    r = c.get("/api/audio", params={"key": "Artista/Artista - Tema.mp3"})

    assert r.status_code == 200
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-type"].startswith("audio/")
    assert r.headers["content-length"] == str(len(CONTENIDO))
    assert r.content == CONTENIDO


# --------------------------------------------------------------------- 206
def test_rango_cerrado_da_206_con_bytes_exactos(api):
    c, root = api
    _plantar(root, "A/x.mp3")
    r = c.get("/api/audio", params={"key": "A/x.mp3"},
              headers={"Range": "bytes=2-5"})

    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes 2-5/{len(CONTENIDO)}"
    assert r.headers["content-length"] == "4"
    assert r.headers["accept-ranges"] == "bytes"
    assert r.content == CONTENIDO[2:6]


def test_rango_desde_inicio_da_206(api):
    c, root = api
    _plantar(root, "A/x.mp3")
    r = c.get("/api/audio", params={"key": "A/x.mp3"},
              headers={"Range": "bytes=250-"})

    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes 250-{len(CONTENIDO) - 1}/{len(CONTENIDO)}"
    assert r.content == CONTENIDO[250:]


def test_rango_sufijo_da_206(api):
    c, root = api
    _plantar(root, "A/x.mp3")
    r = c.get("/api/audio", params={"key": "A/x.mp3"},
              headers={"Range": "bytes=-4"})

    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes {len(CONTENIDO) - 4}-{len(CONTENIDO) - 1}/{len(CONTENIDO)}"
    assert r.content == CONTENIDO[-4:]


def test_rango_que_pasa_del_tamano_se_recorta(api):
    c, root = api
    _plantar(root, "A/x.mp3")
    r = c.get("/api/audio", params={"key": "A/x.mp3"},
              headers={"Range": "bytes=250-9999"})

    assert r.status_code == 206
    assert r.content == CONTENIDO[250:]


# --------------------------------------------------------------------- 416
def test_rango_insatisfacible_da_416(api):
    c, root = api
    _plantar(root, "A/x.mp3")
    r = c.get("/api/audio", params={"key": "A/x.mp3"},
              headers={"Range": "bytes=99999-"})

    assert r.status_code == 416
    assert r.headers["content-range"] == f"bytes */{len(CONTENIDO)}"


# ----------------------------------------------- rangos que se ignoran (200)
@pytest.mark.parametrize("rango", [
    "bytes=abc",          # sintaxis rota
    "paginas=1-2",        # otra unidad
    "bytes=1-2,4-5",      # multi-range: se ignora
    "bytes=5-3",          # ultimo < primero
    "nonsense",
])
def test_rango_malo_o_multiple_se_ignora_y_manda_todo(api, rango):
    c, root = api
    _plantar(root, "A/x.mp3")
    r = c.get("/api/audio", params={"key": "A/x.mp3"},
              headers={"Range": rango})

    assert r.status_code == 200
    assert r.content == CONTENIDO
    assert "content-range" not in r.headers


# --------------------------------------------------------------------- 404
@pytest.mark.parametrize("key", [
    "../secreto.mp3",
    "/etc/passwd.mp3",
    "a\\b.mp3",
    "C:/x.mp3",
    "Artista/../../secreto.mp3",
])
def test_clave_que_escapa_da_404(api, key):
    c, root = api
    # aunque el archivo exista fuera, la clave no puede salir de la raiz
    _plantar(root, "Artista/ok.mp3")
    r = c.get("/api/audio", params={"key": key})
    assert r.status_code == 404
    assert r.json()["detail"] == "no encontrado"


def test_clave_inexistente_da_404(api):
    c, root = api
    r = c.get("/api/audio", params={"key": "A/no-existe.mp3"})
    assert r.status_code == 404
    assert r.json()["detail"] == "no encontrado"


def test_archivo_sin_extension_de_audio_da_404(api):
    c, root = api
    _plantar(root, "A/notas.txt")
    r = c.get("/api/audio", params={"key": "A/notas.txt"})
    assert r.status_code == 404
    assert r.json()["detail"] == "no encontrado"


# --------------------------------------------------------------------- HEAD
def test_head_devuelve_los_mismos_headers_sin_cuerpo(api):
    c, root = api
    _plantar(root, "A/x.mp3")
    r = c.head("/api/audio", params={"key": "A/x.mp3"})

    assert r.status_code == 200
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-length"] == str(len(CONTENIDO))
    assert r.content == b""
