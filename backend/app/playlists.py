"""Playlists del usuario (roadmap, sesion 19).

Una playlist es una lista ORDENADA de claves de la biblioteca (`Playlist.keys`),
mas un nombre y un `updated_at`. Igual que el indice (`cloud/library_index.py`)
la sincronizacion entre dispositivos es un merge por id donde gana el
`updated_at` mas nuevo, y un borrado deja un tombstone para que otro
dispositivo no lo resucite con una copia vieja.

Modulo NEUTRAL y sin I/O: no importa starlette ni uvicorn, y no toca el disco ni
la nube. Los adapters de `storage` son quienes persisten el `PlaylistBook`.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field, replace

from .storage import validate_key

#: Version del formato. Un major distinto se rechaza en vez de adivinar.
VERSION = 1

#: Limites de la API. Una playlist enorme no entra en un archivo chico de nube.
MAX_NAME_LEN = 100
MAX_KEYS = 5000
MAX_ID_LEN = 64

#: El id viaja en la URL y en el nombre del archivo de la nube: solo ASCII
#: seguro, sin separadores ni espacios.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class PlaylistFormatError(ValueError):
    """El `playlists-*.json` remoto no tiene el formato que se entiende."""


@dataclass
class Playlist:
    """Una playlist. `deleted` es un tombstone, como en `IndexEntry`."""

    id: str
    name: str
    keys: list[str]
    updated_at: float
    deleted: bool = False


def _playlist_from_dict(raw: object) -> Playlist | None:
    """Playlist desde JSON. None si le falta algo o viene mal formada.

    Las claves que no son texto se descartan (una entrada rota no puede
    invalidar la playlist entera); una clave que no es un nombre de archivo
    posible se queda: `validate_key` es cosa de la API, no del merge.
    """
    if not isinstance(raw, dict):
        return None
    pid = raw.get("id")
    if not isinstance(pid, str) or not pid or len(pid) > MAX_ID_LEN:
        return None
    name = raw.get("name")
    if not isinstance(name, str):
        return None
    keys = raw.get("keys")
    if not isinstance(keys, list):
        return None
    updated_at = raw.get("updated_at")
    # `bool` es subclase de `int`: True no es una fecha.
    if isinstance(updated_at, bool) or not isinstance(updated_at, (int, float)):
        return None
    return Playlist(
        id=pid,
        name=name,
        keys=[k for k in keys if isinstance(k, str)],
        updated_at=float(updated_at),
        deleted=bool(raw.get("deleted", False)),
    )


@dataclass
class PlaylistBook:
    """Todas las playlists de UN dispositivo. `playlists` va por id."""

    playlists: dict[str, Playlist] = field(default_factory=dict)
    version: int = VERSION

    def to_bytes(self) -> bytes:
        """JSON UTF-8 con claves ordenadas: bytes ESTABLES para comparar."""
        payload = {
            "version": self.version,
            "playlists": [asdict(self.playlists[k])
                          for k in sorted(self.playlists)],
        }
        return json.dumps(payload, sort_keys=True,
                          ensure_ascii=False).encode("utf-8")

    @classmethod
    def from_bytes(cls, data: bytes) -> PlaylistBook:
        """Reconstruye el libro. Rechaza un major desconocido; salta lo feo."""
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise PlaylistFormatError(
                "las playlists no son JSON valido") from exc
        if not isinstance(payload, dict):
            raise PlaylistFormatError("las playlists no son un objeto JSON")
        if payload.get("version") != VERSION:
            raise PlaylistFormatError(
                f"version de playlists desconocida: {payload.get('version')!r}")
        book = cls()
        for raw in payload.get("playlists", []):
            playlist = _playlist_from_dict(raw)
            if playlist is None:
                continue
            book.playlists[playlist.id] = playlist
        return book

    def upsert(self, playlist: Playlist) -> None:
        self.playlists[playlist.id] = playlist

    def remove(self, playlist_id: str, now: float) -> None:
        """Escribe un tombstone con el `updated_at` nuevo.

        El nombre se conserva (la UI puede mostrar que se borro) y las claves se
        vacian: un tombstone no tiene por que seguir guardando la lista.
        """
        current = self.playlists.get(playlist_id)
        if current is None:
            self.playlists[playlist_id] = Playlist(
                id=playlist_id, name="", keys=[], updated_at=now, deleted=True)
        else:
            self.playlists[playlist_id] = replace(
                current, deleted=True, keys=[], updated_at=now)

    def live(self) -> list[Playlist]:
        """Las playlists vigentes, ordenadas por nombre (casefold) e id."""
        vivas = [p for p in self.playlists.values() if not p.deleted]
        return sorted(vivas, key=lambda p: (p.name.casefold(), p.id))

    def merge(self, other: PlaylistBook) -> PlaylistBook:
        """Por id gana el `updated_at` mas nuevo. En empate, gana el propio."""
        merged = PlaylistBook(playlists=dict(self.playlists))
        for playlist_id, playlist in other.playlists.items():
            mine = merged.playlists.get(playlist_id)
            if mine is None or playlist.updated_at > mine.updated_at:
                merged.playlists[playlist_id] = playlist
        return merged


def validate_playlist(playlist_id: str, name: object,
                      keys: object) -> tuple[str, list[str]]:
    """Valida lo que llega por la API y devuelve `(nombre limpio, claves)`.

    El nombre se recorta; las claves repetidas se descartan conservando la
    primera aparicion (el orden de la playlist es lo que el usuario eligio).
    Levanta `ValueError` con un mensaje corto en castellano.
    """
    if not isinstance(playlist_id, str) or not _ID_RE.match(playlist_id):
        raise ValueError("id de playlist invalido")
    if not isinstance(name, str):
        raise ValueError("el nombre de la playlist tiene que ser texto")
    clean = name.strip()
    if not clean:
        raise ValueError("el nombre de la playlist no puede estar vacio")
    if len(clean) > MAX_NAME_LEN:
        raise ValueError("el nombre de la playlist es demasiado largo")
    if not isinstance(keys, list) or not all(isinstance(k, str) for k in keys):
        raise ValueError("las claves tienen que ser una lista de textos")
    if len(keys) > MAX_KEYS:
        raise ValueError("la playlist tiene demasiadas canciones")
    out: list[str] = []
    seen: set[str] = set()
    for key in keys:
        validate_key(key)  # InvalidKey es un ValueError
        if key in seen:
            continue
        seen.add(key)
        out.append(key)
    return clean, out
