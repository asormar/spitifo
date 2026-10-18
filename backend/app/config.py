"""Constantes compartidas. Módulo neutral para romper ciclos de import."""
from __future__ import annotations

# Identificacion que mandamos a iTunes/Internet Archive/Wikimedia. Vive aca y
# no en sources.py: asi la usan sources, downloader, identify y matcher sin
# que ninguno dependa de otro.
USER_AGENT = "spitifo/0.1 (+https://github.com/asormar/spitifo)"

LIBRARY_NAME = "library"
AUDIO_EXTS = (".mp3", ".flac", ".ogg", ".m4a", ".opus", ".wav")
#: Video de la biblioteca (bajado de YouTube con media=video o media=both).
#: Vive en la MISMA biblioteca que el audio: la clave es la misma, cambia la
#: extension. `video` ademas agrega el sufijo " (sin audio)" al nombre.
VIDEO_EXTS = (".mp4", ".webm", ".mkv")
#: Miniatura de un video: sidecar `<mismo nombre>.jpg` al lado del archivo.
IMAGE_EXTS = (".jpg",)
