"""Biblioteca con video y miniaturas: listado, deteccion y serving.

Todo OFFLINE sobre `LocalStorage` (una carpeta temporal). Cubre:
- `library_scan`: `kind`, `thumb_key`, `has_audio` y los `.jpg` huerfanos ocultos.
- `/api/audio`: sirve `.mp4/.webm/.mkv/.jpg` con su Content-Type y con el mismo
  manejo de `Range` (206/416/404) que ya tenia el audio.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from backend.app.main import create_app
from backend.app.storage import set_storage
from backend.app.storage.local import LocalStorage

CONTENIDO = bytes(range(256))  # cada offset se distingue


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
        set_storage(None)


def _plantar(root: Path, key: str, data: bytes = CONTENIDO) -> None:
    p = root / key
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)


# --------------------------------------------------------------- library_scan
def test_library_scan_marca_video_miniatura_y_audio(tmp_path, storage_temporal):
    import backend.app.downloader as dl

    storage_temporal(tmp_path)
    (tmp_path / "A").mkdir()
    for nombre in ("A - Tema.mp3", "A - Tema.jpg", "A - Clip.mp4",
                   "A - Mudo (sin audio).webm", "suelta.jpg"):
        (tmp_path / "A" / nombre).write_bytes(b"\x00" * 32)

    escaneo = {f["filename"]: f for f in dl.library_scan()}

    # el jpg huerfano NO aparece como tema propio
    assert "suelta.jpg" not in escaneo
    assert set(escaneo) == {"A - Tema.mp3", "A - Clip.mp4", "A - Mudo (sin audio).webm"}

    # audio con sidecar: kind audio y thumb_key presente
    assert escaneo["A - Tema.mp3"]["kind"] == "audio"
    assert escaneo["A - Tema.mp3"]["thumb_key"] == "A/A - Tema.jpg"
    assert escaneo["A - Tema.mp3"]["has_audio"] is True

    # video sin sidecar: thumb_key None, tiene audio
    assert escaneo["A - Clip.mp4"]["kind"] == "video"
    assert escaneo["A - Clip.mp4"]["thumb_key"] is None
    assert escaneo["A - Clip.mp4"]["has_audio"] is True

    # video "sin audio": has_audio False y su propio sidecar (que no existe -> None)
    assert escaneo["A - Mudo (sin audio).webm"]["kind"] == "video"
    assert escaneo["A - Mudo (sin audio).webm"]["has_audio"] is False
    assert escaneo["A - Mudo (sin audio).webm"]["thumb_key"] is None

    # los campos de siempre siguen
    assert escaneo["A - Clip.mp4"]["bytes"] == 32
    assert escaneo["A - Clip.mp4"]["folder"] == "A"
    assert escaneo["A - Clip.mp4"]["key"] == "A/A - Clip.mp4"


def test_library_scan_muestra_kind_y_thumb_en_la_api(api, tmp_path):
    c, root = api
    _plantar(root, "A/A - Clip.mp4")
    _plantar(root, "A/A - Clip.jpg")

    r = c.get("/api/library")
    assert r.status_code == 200
    por_key = {f["key"]: f for f in r.json()["files"]}
    assert por_key["A/A - Clip.mp4"]["kind"] == "video"
    assert por_key["A/A - Clip.mp4"]["thumb_key"] == "A/A - Clip.jpg"
    assert "A/A - Clip.jpg" not in por_key  # el sidecar no es un tema
    # Escuchar agrupa con las etiquetas; un archivo sin ellas las trae en None
    clip = por_key["A/A - Clip.mp4"]
    assert (clip["title"], clip["artist"], clip["album"]) == (None, None, None)


# ------------------------------------------------------------------- serving
@pytest.mark.parametrize("nombre,mime", [
    ("A/V.mp4", "video/mp4"),
    ("A/V.webm", "video/webm"),
    ("A/V.mkv", "video/x-matroska"),
    ("A/V.jpg", "image/jpeg"),
])
def test_sirve_media_con_su_content_type(api, nombre, mime):
    c, root = api
    _plantar(root, nombre)
    r = c.get("/api/audio", params={"key": nombre})

    assert r.status_code == 200
    assert r.headers["content-type"].startswith(mime)
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-length"] == str(len(CONTENIDO))
    assert r.content == CONTENIDO


def test_rango_de_un_video_da_206(api):
    c, root = api
    _plantar(root, "A/V.mp4")
    r = c.get("/api/audio", params={"key": "A/V.mp4"},
              headers={"Range": "bytes=2-5"})

    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes 2-5/{len(CONTENIDO)}"
    assert r.headers["content-length"] == "4"
    assert r.content == CONTENIDO[2:6]


def test_rango_de_una_miniatura_da_206(api):
    c, root = api
    _plantar(root, "A/V.jpg")
    r = c.get("/api/audio", params={"key": "A/V.jpg"},
              headers={"Range": "bytes=-4"})

    assert r.status_code == 206
    assert r.content == CONTENIDO[-4:]


def test_rango_insatisfacible_de_video_da_416(api):
    c, root = api
    _plantar(root, "A/V.mkv")
    r = c.get("/api/audio", params={"key": "A/V.mkv"},
              headers={"Range": "bytes=99999-"})

    assert r.status_code == 416
    assert r.headers["content-range"] == f"bytes */{len(CONTENIDO)}"


def test_video_inexistente_da_404(api):
    c, root = api
    r = c.get("/api/audio", params={"key": "A/no-esta.mp4"})
    assert r.status_code == 404
    assert r.json()["detail"] == "no encontrado"


def test_extension_que_no_es_media_da_404(api):
    c, root = api
    _plantar(root, "A/notas.txt")
    r = c.get("/api/audio", params={"key": "A/notas.txt"})
    assert r.status_code == 404
    assert r.json()["detail"] == "no encontrado"


@pytest.mark.parametrize("key", [
    "../secreto.mp4",
    "/etc/passwd.mp4",
    "a\\b.mp4",
    "Artista/../../secreto.jpg",
])
def test_clave_de_video_que_escapa_da_404(api, key):
    c, root = api
    _plantar(root, "Artista/ok.mp4")
    r = c.get("/api/audio", params={"key": key})
    assert r.status_code == 404


# --------------------------------------------------------------------- MIME
def test_mime_de_video_y_miniatura_registrados():
    """Android no trae base MIME: video y `.jpg` se registran como el audio."""
    import mimetypes

    from backend.app.runtime import MEDIA_MIME_TYPES, register_media_mime_types

    register_media_mime_types()
    for ext, mime in MEDIA_MIME_TYPES.items():
        assert mimetypes.guess_type(f"x{ext}")[0] == mime, ext


def test_mime_of_del_adapter_de_nube_sabe_video_y_jpg():
    from backend.app.cloud.base import _mime_of

    assert _mime_of("A/V.mp4") == "video/mp4"
    assert _mime_of("A/V.webm") == "video/webm"
    assert _mime_of("A/V.mkv") == "video/x-matroska"
    assert _mime_of("A/V.jpg") == "image/jpeg"
    assert _mime_of("A/raro.zzz") == "application/octet-stream"

