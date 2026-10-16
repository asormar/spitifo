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

Nada de acá importa starlette ni uvicorn: es un módulo neutral.
"""
from __future__ import annotations

import mimetypes
import os

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


def register_audio_mime_types() -> None:
    """Registra los MIME de audio en la base global de `mimetypes`."""
    for ext, mime in AUDIO_MIME_TYPES.items():
        mimetypes.add_type(mime, ext)


def configure_runtime() -> None:
    """Todo lo que hay que dejar listo antes de servir la primera request."""
    register_audio_mime_types()
    setup_ffmpeg_dir()
