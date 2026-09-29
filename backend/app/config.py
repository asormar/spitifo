"""Constantes compartidas. Módulo neutral para romper ciclos de import."""
from __future__ import annotations

# Identificacion que mandamos a iTunes/Internet Archive/Wikimedia. Vive aca y
# no en sources.py: asi la usan sources, downloader, identify y matcher sin
# que ninguno dependa de otro.
USER_AGENT = "spitifo/0.1 (+https://github.com/asormar/spitifo)"

LIBRARY_NAME = "library"
AUDIO_EXTS = (".mp3", ".flac", ".ogg", ".m4a", ".opus", ".wav")
