"""Ajustes de entorno que el backend hace una sola vez, al arrancar.

Existe por dos cosas que en el escritorio no hacen falta pero al embeber el
backend sí (Tauri en Windows, Chaquopy/WebView en Android):

1. **ffmpeg inyectable.** En Android ffmpeg/ffprobe no están en el `PATH` del
   sistema: los trae la app y viven en su directorio de librerías nativas.
   `SPITIFO_FFMPEG_DIR` deja apuntar ahí y el resto del backend (que no cambia)
   los encuentra con `shutil.which`.
2. **MIME de audio.** Android no tiene base de datos MIME del sistema, así que
   `mimetypes.guess_type(".ogg")` devolvía `None` y `FileResponse` servía el
   archivo como `application/octet-stream`: el `<audio>` no lo reconocía.

3. **yt-dlp reemplazable.** YouTube rompe yt-dlp varias veces al año y en Android
   no hay `pip`. `SPITIFO_YTDLP_DIR` apunta a una carpeta (con `yt_dlp/` adentro)
   o al zip oficial de yt-dlp; va al frente de `sys.path` y gana sobre el que
   viene empaquetado. Acá solo está el gancho de carga; quien baja las versiones
   nuevas es otra sesión.

Nada de acá importa starlette ni uvicorn: es un módulo neutral.
"""
from __future__ import annotations

import importlib
import logging
import mimetypes
import os
import sys

log = logging.getLogger("spitifo.runtime")

# Tipos que el navegador/WebView tiene que reconocer para poder reproducir sin
# descargar. `.opus` va como audio/ogg: es un flujo Ogg y es lo que espera el
# motor de audio de Chromium.
AUDIO_MIME_TYPES = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
}


def prepend_to_path(directory: str) -> bool:
    """Pone `directory` al frente de `PATH`, una sola vez.

    Devuelve True si lo agregó y False si ya estaba (o si `directory` es
    vacío). Es idempotente a propósito: arrancar el backend dos veces en el
    mismo proceso no tiene que llenar el PATH de copias.
    """
    if not directory:
        return False
    partes = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    if directory in partes:
        return False
    os.environ["PATH"] = os.pathsep.join([directory, *partes])
    return True


def setup_ffmpeg_dir() -> bool:
    """Aplica `SPITIFO_FFMPEG_DIR` al PATH. False si la variable no está."""
    return prepend_to_path(os.getenv("SPITIFO_FFMPEG_DIR", ""))


def setup_ytdlp_dir() -> bool:
    """Pone `SPITIFO_YTDLP_DIR` al frente de `sys.path`, una sola vez.

    Sirve una carpeta que contenga `yt_dlp/` o el archivo zip oficial (Python
    importa zips desde `sys.path`). Devuelve False si la variable no está, si la
    ruta no existe o si ya estaba al frente. Tiene que correr ANTES del primer
    `import yt_dlp`: con el módulo ya cargado, el reemplazo no tendría efecto.
    """
    ruta = os.getenv("SPITIFO_YTDLP_DIR", "")
    if not ruta:
        return False
    if not os.path.exists(ruta):
        log.warning("SPITIFO_YTDLP_DIR no existe: %s", ruta)
        return False
    if sys.path and sys.path[0] == ruta:
        return False
    if "yt_dlp" in sys.modules:
        log.warning("yt_dlp ya estaba importado: SPITIFO_YTDLP_DIR no lo reemplaza")
    sys.path.insert(0, ruta)
    importlib.invalidate_caches()
    return True


def ytdlp_version() -> str | None:
    """Version de yt-dlp que se esta usando de verdad, o None si no se importa.

    No se cachea: tras el primer import es un lookup en sys.modules, y asi el
    valor siempre refleja el modulo que esta cargado.
    """
    try:
        from yt_dlp import version
        return str(version.__version__)
    except Exception:
        return None


def register_audio_mime_types() -> None:
    """Registra los MIME de audio en la base global de `mimetypes`."""
    for ext, mime in AUDIO_MIME_TYPES.items():
        mimetypes.add_type(mime, ext)


def configure_runtime() -> None:
    """Todo lo que hay que dejar listo antes de servir la primera request."""
    register_audio_mime_types()
    setup_ffmpeg_dir()
    setup_ytdlp_dir()
