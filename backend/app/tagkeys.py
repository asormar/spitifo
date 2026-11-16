"""Claves de album de iTunes en el modo `easy` de mutagen.

El collectionId no es una etiqueta estandar: TXXX en ID3 y atomo libre en MP4.
Se registra UNA vez al importar este modulo, asi los lectores (local y nube)
abren cada archivo una sola vez y leen todo del mismo objeto easy. En
FLAC/Vorbis la clave ya funciona en minusculas: los comentarios Vorbis son
case-insensitive.
"""
from __future__ import annotations

from mutagen.easyid3 import EasyID3
from mutagen.easymp4 import EasyMP4Tags

#: Nombre de la clave extra, identico en los tres formatos.
ALBUM_ID_KEY = "itunes_collection_id"

EasyID3.RegisterTXXXKey(ALBUM_ID_KEY, "ITUNES_COLLECTION_ID")
EasyMP4Tags.RegisterFreeformKey(ALBUM_ID_KEY, "ITUNES_COLLECTION_ID")


def _first(audio, name: str) -> str | None:
    """Primer valor de una clave easy, o None si no esta o no se puede leer."""
    try:
        value = audio.get(name)
    except Exception:
        return None
    if not value:
        return None
    text = str(value[0]).strip()
    return text or None


def easy_number(audio, name: str) -> int | None:
    """Entero antes de '/' de tracknumber/discnumber (None si no es numero)."""
    value = _first(audio, name)
    if value is None:
        return None
    parte = value.split("/", 1)[0].strip()
    try:
        return int(parte)
    except ValueError:
        return None


def easy_album_id(audio) -> str | None:
    """collectionId de iTunes leido con la clave registrada arriba."""
    return _first(audio, ALBUM_ID_KEY)
