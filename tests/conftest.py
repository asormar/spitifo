"""Fixtures compartidas de la suite de Spitifo.

Lo importante de este archivo son tres cosas:

1. Que la RAÍZ del repo quede importable (`backend.app...`) sin depender de cómo
   se invoque pytest.
2. Que `SPITIFO_LIBRARY` apunte a una carpeta TEMPORAL **antes** de importar
   `backend.app.downloader` (que lee la variable al importarse). Si no, los tests
   de integración ensucian la biblioteca real de la persona. La biblioteca se
   sirve por el puerto `Storage`: `get_storage()` la arma con esa variable.
3. Fixtures de apoyo que no necesitan red: un WAV/MP3 sintético con ffmpeg,
   blobs ID3 armados con mutagen, y una fuente YouTube falsa.

Ninguna fixture de red: los tests que pegan a internet están en
test_*.py marcados con `@pytest.mark.integration` y llevan timeout explícito.
"""
from __future__ import annotations

import io
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

# --- 1) la raiz del repo tiene que ser importable -----------------------------
RAIZ = Path(__file__).resolve().parents[1]
if str(RAIZ) not in sys.path:
    sys.path.insert(0, str(RAIZ))

# --- 2) biblioteca temporal, seteada ANTES de importar el backend --------------
# downloader.py hace LIBRARY = Path(os.getenv("SPITIFO_LIBRARY", ...)) al ser
# importado, así que esto tiene que correr antes del primer import de backend.
LIBRARY_TEMPORAL = Path(tempfile.mkdtemp(prefix="spitifo-tests-"))
os.environ["SPITIFO_LIBRARY"] = str(LIBRARY_TEMPORAL)

# --- 2b) datos del usuario tambien temporales ----------------------------------
# `get_storage()` lee `storage.json` de la carpeta de datos y, si dice "google",
# arma Drive con los tokens guardados ahi. Sin esto, una persona con Drive
# conectado en esta maquina hace que los tests de descarga suban archivos
# falsos a SU cuenta (paso el 2026-10-17). Tambien la cache de audio, y fuera
# las variables que eligen proveedor o traen client IDs reales.
DATOS_TEMPORALES = Path(tempfile.mkdtemp(prefix="spitifo-tests-data-"))
os.environ["SPITIFO_DATA_DIR"] = str(DATOS_TEMPORALES)
os.environ["SPITIFO_CACHE_DIR"] = str(DATOS_TEMPORALES / "cache")
for _var in ("SPITIFO_STORAGE", "SPITIFO_GOOGLE_CLIENT_ID",
             "SPITIFO_GOOGLE_CLIENT_SECRET", "SPITIFO_MS_CLIENT_ID"):
    os.environ.pop(_var, None)


@pytest.fixture(autouse=True)
def _sin_client_ids_reales(monkeypatch, tmp_path):
    """El `oauth_clients.json` empaquetado (gitignoreado) puede tener los IDs
    reales de la persona: ningun test lo lee."""
    from backend.app.cloud import oauth
    monkeypatch.setattr(oauth, "BUNDLED_CONFIG", tmp_path / "no-bundled.json")

# --- tiempo maximo para cualquier test que hable con una API externa ----------
TIMEOUT_RED = 30.0


# --------------------------------------------------------------- red / ffmpeg
def ffmpeg_disponible() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def ffprobe_duracion(path: Path | str) -> float:
    """Duracion real en segundos, medida desde disco con ffprobe.

    Un 200 en la API NO prueba que el audio sea valido: esto es el contraste
    independiente que hay que hacer siempre.
    """
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


@pytest.fixture(scope="session")
def ffmpeg() -> None:
    if not ffmpeg_disponible():
        pytest.skip("ffmpeg/ffprobe no esta en el PATH: no se puede convertir")


@pytest.fixture(scope="session")
def wav_sintetico(ffmpeg, tmp_path_factory) -> Path:
    """WAV de 3s de un tono de 440Hz. No viene de la red, es sintetico."""
    dest = tmp_path_factory.mktemp("audio") / "tono.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
         "-ac", "1", "-ar", "44100", str(dest)],
        check=True, capture_output=True)
    assert dest.exists() and dest.stat().st_size > 0
    return dest


@pytest.fixture(scope="session")
def mp3_desde_wav(ffmpeg, wav_sintetico, tmp_path_factory) -> Path:
    """El mismo WAV convertido a MP3 con la MISMA ruta de ffmpeg que la app."""
    dest = tmp_path_factory.mktemp("audio") / "tono.mp3"
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(wav_sintetico), "-vn", "-codec:a", "libmp3lame",
         "-q:a", "2", str(dest)],
        check=True, capture_output=True)
    return dest


# ------------------------------------------------------------------- ID3/tags
@pytest.fixture(scope="session")
def blob_id3() -> bytes:
    """Blob ID3 armado con mutagen: lo que `identify.parse_id3` tiene que leer."""
    from mutagen.id3 import ID3, TALB, TDRC, TIT2, TPE1

    tags = ID3()
    tags.add(TIT2(encoding=3, text="Numb"))
    tags.add(TPE1(encoding=3, text="Linkin Park"))
    tags.add(TALB(encoding=3, text="Hybrid Theory"))
    tags.add(TDRC(encoding=3, text="2000"))
    buf = io.BytesIO()
    tags.save(buf)
    return buf.getvalue()


# ------------------------------------------------------------ fuente YouTube
class FuenteYtDlpFalsa:
    """Doble de `YtDlpSource` que devuelve videos fijos, sin tocar la red.

    Es lo que permite testear el.matcher entero de forma offline, que es la
    cobertura que mas valor aporta: el matching es la logica mas delicada y la
    unica forma de no depender de YouTube es con un doble.
    """

    def __init__(self, videos: list[dict], disponible: bool = True) -> None:
        self.videos = videos
        self.disponible = disponible
        self.llamadas = 0

    def available(self) -> bool:
        return self.disponible

    async def search_candidates(self, q: str, limit: int = 40) -> list[dict]:
        self.llamadas += 1
        return list(self.videos)


class FuenteYtDlpRota(FuenteYtDlpFalsa):
    """La busqueda falla, como cuando YouTube no responde."""

    async def search_candidates(self, q: str, limit: int = 40) -> list[dict]:
        raise RuntimeError("yt-dlp: la API no respondio")


@pytest.fixture
def fake_ytdlp():
    """Factory: `fake_ytdlp([{...videos...}])` -> fuente doble."""
    return FuenteYtDlpFalsa


# ------------------------------------------------------------------- cliente
@pytest.fixture(scope="session")
def cliente():
    """TestClient de Starlette en proceso: no hace falta levantar el server.

    Sale del contexto para disparar el lifespan (registra yt-dlp) y cerrarlo.
    """
    from starlette.testclient import TestClient

    from backend.app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def biblioteca() -> Path:
    """Carpeta donde los tests de integración dejan las descargas."""
    return LIBRARY_TEMPORAL


@pytest.fixture
def storage_temporal():
    """Factory: `storage_temporal(root)` instala un `LocalStorage` y lo restaura.

    Devuelve el adapter instalado. Al terminar el test vuelve al de siempre
    (`set_storage(None)`), asi que un test no le deja la biblioteca cambiada al
    siguiente.
    """
    from backend.app.storage import set_storage
    from backend.app.storage.local import LocalStorage

    def _instalar(root: Path):
        s = LocalStorage(root)
        set_storage(s)
        return s

    yield _instalar
    set_storage(None)
