"""Canciones guardadas en la biblioteca, bajadas o no (ADR 0004).

Una cancion guardada existe en la biblioteca aunque su archivo no este: se
reproduce por streaming. `file_key` senala el archivo descargado, si lo hay.
Igual que el indice y las playlists, la sincronizacion entre dispositivos es un
merge por id donde gana el `updated_at` mas nuevo y un borrado deja un tombstone
para que otro dispositivo no resucite la cancion con una copia vieja.

La identidad es estable y NO es una URL: las URLs de streaming vencen. `id` es
`yt:<videoId>` (YouTube) o `ia:<identifier>` (Internet Archive).

Modulo NEUTRAL y sin I/O: no importa starlette ni uvicorn, y no toca el disco ni
la nube. Los adapters de `storage` son quienes persisten el `SavedBook`.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field, replace

from .storage import validate_key

#: Version del formato. Un major distinto se rechaza en vez de adivinar.
VERSION = 1

#: Fuentes admitidas y su prefijo de id.
SOURCE_YOUTUBE = "youtube"
SOURCE_ARCHIVE = "archive"
_PREFIXES = {SOURCE_YOUTUBE: "yt:", SOURCE_ARCHIVE: "ia:"}

#: Limites de la API y del archivo. Un libro enorme no entra en un archivo
#: chico de nube.
MAX_TITLE_LEN = 300
MAX_ARTIST_LEN = 300
MAX_ALBUM_LEN = 300
MAX_URL_LEN = 2000
MAX_SONGS = 500

#: Un videoId de YouTube son 11 caracteres ASCII seguro; un identifier de
#: Internet Archive admite puntos, guiones y guiones bajos. Ninguno admite `:`,
#: `/` ni `?`: una URL de streaming nunca puede ser un id.
_YT_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_IA_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")

#: Claves permitidas en `itunes`, todas enteras.
_ITUNES_KEYS = frozenset(
    {"track_id", "collection_id", "artist_id", "track_no", "disc_no",
     "track_count"})


class SavedFormatError(ValueError):
    """El `library-*.json` remoto no tiene el formato que se entiende."""


@dataclass(frozen=True)
class SavedSong:
    """Una cancion guardada. `deleted` es un tombstone, como en `IndexEntry`."""

    id: str
    title: str
    artist: str
    album: str | None
    duration: float | None
    artwork_url: str | None
    source: str
    source_id: str
    itunes: dict
    file_key: str | None
    added_at: float
    updated_at: float
    deleted: bool = False


def _split_song_id(song_id_value: str) -> tuple[str, str]:
    """`(source, source_id)` de un id valido. Levanta `ValueError` si no lo es."""
    if not isinstance(song_id_value, str):
        raise ValueError("id de cancion invalido")
    for source, prefix in _PREFIXES.items():
        if song_id_value.startswith(prefix):
            raw = song_id_value[len(prefix):]
            pattern = _YT_RE if source == SOURCE_YOUTUBE else _IA_RE
            if not pattern.match(raw):
                raise ValueError("id de cancion invalido")
            return source, raw
    raise ValueError("id de cancion invalido")


def song_id(source: str, source_id: str) -> str:
    """Compone el id estable de una cancion a partir de su fuente."""
    if source not in _PREFIXES:
        raise ValueError("fuente de cancion desconocida")
    if not isinstance(source_id, str):
        raise ValueError("source_id tiene que ser texto")
    _split_song_id(_PREFIXES[source] + source_id)
    return _PREFIXES[source] + source_id


def validate_song_id(song_id_value: str) -> str:
    """Valida un id de cancion y lo devuelve tal cual si lo es."""
    _split_song_id(song_id_value)
    return song_id_value


def _is_number(value: object) -> bool:
    """`int`/`float` pero no `bool` (que es subclase de `int`)."""
    return not isinstance(value, bool) and isinstance(value, (int, float))


def _valid_itunes(raw: object) -> dict:
    """Valida el diccionario `itunes`: solo claves conocidas, valores enteros."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("itunes tiene que ser un objeto")
    out: dict[str, int] = {}
    for key, value in raw.items():
        if key not in _ITUNES_KEYS:
            raise ValueError("clave de itunes desconocida")
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("los valores de itunes tienen que ser enteros")
        out[key] = value
    return out


def _clean_song(raw: object, *, stored: bool) -> dict:
    """Valida un registro y devuelve sus campos limpios.

    `stored=True` exige ademas `added_at` y `updated_at` (el archivo en disco).
    En la API esos campos los pone el servidor. Levanta `ValueError` con un
    mensaje corto en castellano.
    """
    if not isinstance(raw, dict):
        raise ValueError("cada cancion tiene que ser un objeto")
    sid = raw.get("id")
    if not isinstance(sid, str):
        raise ValueError("id de cancion invalido")
    source = raw.get("source")
    source_id = raw.get("source_id")
    if source not in _PREFIXES or not isinstance(source_id, str):
        raise ValueError("fuente o source_id invalidos")
    # El id se compone con los campos del cliente: asi se valida su formato y
    # que la fuente y el source_id no mientan sobre el id.
    if song_id(source, source_id) != sid:
        raise ValueError("id, fuente y source_id no coinciden")
    title = raw.get("title")
    if not isinstance(title, str) or len(title) > MAX_TITLE_LEN:
        raise ValueError("titulo de cancion invalido")
    artist = raw.get("artist")
    if not isinstance(artist, str) or len(artist) > MAX_ARTIST_LEN:
        raise ValueError("artista de cancion invalido")
    album = raw.get("album")
    if album is not None and (not isinstance(album, str)
                              or len(album) > MAX_ALBUM_LEN):
        raise ValueError("album de cancion invalido")
    duration = raw.get("duration")
    if duration is not None and not _is_number(duration):
        raise ValueError("duracion de cancion invalida")
    artwork = raw.get("artwork_url")
    if artwork is not None and (not isinstance(artwork, str)
                                or len(artwork) > MAX_URL_LEN):
        raise ValueError("artwork_url de cancion invalida")
    file_key = raw.get("file_key")
    if file_key is not None:
        validate_key(file_key)  # InvalidKey es un ValueError
    clean = {
        "id": sid, "title": title, "artist": artist, "album": album,
        "duration": float(duration) if duration is not None else None,
        "artwork_url": artwork, "source": source, "source_id": source_id,
        "itunes": _valid_itunes(raw.get("itunes")), "file_key": file_key,
    }
    if stored:
        added_at, updated_at = raw.get("added_at"), raw.get("updated_at")
        if not _is_number(added_at) or not _is_number(updated_at):
            raise ValueError("fechas de cancion invalidas")
        clean["added_at"] = float(added_at)
        clean["updated_at"] = float(updated_at)
        deleted = raw.get("deleted", False)
        if not isinstance(deleted, bool):
            raise ValueError("deleted tiene que ser booleano")
        clean["deleted"] = deleted
    return clean


def _song_from_dict(raw: object) -> SavedSong | None:
    """Cancion desde JSON. None si le falta algo o viene mal formada."""
    try:
        return SavedSong(**_clean_song(raw, stored=True))
    except ValueError:
        return None


@dataclass
class SavedBook:
    """Todas las canciones guardadas de UN dispositivo. `songs` va por id."""

    songs: dict[str, SavedSong] = field(default_factory=dict)
    version: int = VERSION

    def to_bytes(self) -> bytes:
        """JSON UTF-8 con claves ordenadas: bytes ESTABLES para comparar."""
        payload = {
            "version": self.version,
            "songs": [asdict(self.songs[k]) for k in sorted(self.songs)],
        }
        return json.dumps(payload, sort_keys=True,
                          ensure_ascii=False).encode("utf-8")

    @classmethod
    def from_bytes(cls, data: bytes) -> SavedBook:
        """Reconstruye el libro. Rechaza un major desconocido; salta lo feo."""
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise SavedFormatError(
                "las canciones guardadas no son JSON valido") from exc
        if not isinstance(payload, dict):
            raise SavedFormatError(
                "las canciones guardadas no son un objeto JSON")
        if payload.get("version") != VERSION:
            raise SavedFormatError(
                f"version de canciones guardadas desconocida: "
                f"{payload.get('version')!r}")
        book = cls()
        for raw in payload.get("songs", []):
            song = _song_from_dict(raw)
            if song is not None:
                book.songs[song.id] = song
        return book

    def upsert(self, song: SavedSong) -> None:
        self.songs[song.id] = song

    def remove(self, sid: str, now: float) -> None:
        """Escribe un tombstone con el `updated_at` nuevo.

        Si la cancion no estaba, se arma una entrada minima con la fuente
        deducida del id: el tombstone tiene que poder viajar y parsearse.
        """
        source, source_id = _split_song_id(sid)
        current = self.songs.get(sid)
        if current is None:
            self.songs[sid] = SavedSong(
                id=sid, title="", artist="", album=None, duration=None,
                artwork_url=None, source=source, source_id=source_id,
                itunes={}, file_key=None, added_at=now, updated_at=now,
                deleted=True)
        else:
            self.songs[sid] = replace(current, deleted=True, updated_at=now)

    def live(self) -> list[SavedSong]:
        """Las canciones vigentes, de la mas reciente a la mas vieja."""
        vivas = [s for s in self.songs.values() if not s.deleted]
        return sorted(vivas, key=lambda s: (-s.added_at, s.id))

    def merge(self, other: SavedBook) -> SavedBook:
        """Por id gana el `updated_at` mas nuevo. En empate, gana el tombstone."""
        merged = SavedBook(songs=dict(self.songs))
        for sid, song in other.songs.items():
            mine = merged.songs.get(sid)
            if mine is None or song.updated_at > mine.updated_at:
                merged.songs[sid] = song
            elif (song.updated_at == mine.updated_at
                  and song.deleted and not mine.deleted):
                merged.songs[sid] = song
        return merged


def validate_saved_payload(body: object) -> list[dict]:
    """Valida el cuerpo de `PUT /api/saved` y devuelve los registros limpios.

    Las fechas las pone el servidor: aca solo se chequean los campos que trae
    el cliente. Levanta `ValueError` con un mensaje corto en castellano.
    """
    if not isinstance(body, dict):
        raise ValueError("el cuerpo tiene que ser un objeto")
    songs = body.get("songs")
    if not isinstance(songs, list):
        raise ValueError("songs tiene que ser una lista")
    if len(songs) > MAX_SONGS:
        raise ValueError("demasiadas canciones por request")
    return [_clean_song(raw, stored=False) for raw in songs]
