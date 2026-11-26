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
from dataclasses import dataclass, field, replace

from . import saved
from .storage import validate_key

#: Version del formato. Un major distinto se rechaza en vez de adivinar.
VERSION = 1

#: Limites de la API. Una playlist enorme no entra en un archivo chico de nube.
MAX_NAME_LEN = 100
MAX_KEYS = 5000
MAX_ID_LEN = 64
MAX_DESC_LEN = 500

#: El id viaja en la URL y en el nombre del archivo de la nube: solo ASCII
#: seguro, sin separadores ni espacios.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

#: Campos que esta version entiende. Cualquier otra clave del JSON se conserva
#: tal cual en `Playlist.extra`: el archivo lo comparten versiones viejas y
#: nuevas de la app, y una reescritura no puede borrar lo que no entiende.
_KNOWN = frozenset({
    "id", "name", "keys", "updated_at", "deleted",
    "description", "cover_key", "folder_id", "is_folder",
})


class PlaylistFormatError(ValueError):
    """El `playlists-*.json` remoto no tiene el formato que se entiende."""


@dataclass
class Playlist:
    """Una playlist. `deleted` es un tombstone, como en `IndexEntry`.

    `description`, `cover_key`, `folder_id` e `is_folder` son aditivos: un
    cliente viejo los ve como claves desconocidas y los conserva al reescribir
    el archivo. Una carpeta es una playlist con `is_folder` y sus `keys` son
    IDs de playlist, no claves de cancion.
    """

    id: str
    name: str
    keys: list[str]
    updated_at: float
    deleted: bool = False
    description: str = ""
    cover_key: str = ""
    folder_id: str = ""
    is_folder: bool = False
    #: Campos de una version mas nueva. No entra en la igualdad: dos copias de
    #: la misma playlist con distinto `extra` siguen siendo la misma playlist.
    extra: dict[str, object] = field(default_factory=dict, repr=False, compare=False)


def _text(raw: dict, name: str) -> str:
    value = raw.get(name)
    return value if isinstance(value, str) else ""


def _playlist_from_dict(raw: object) -> Playlist | None:
    """Playlist desde JSON. None si le falta algo o viene mal formada.

    Las claves que no son texto se descartan (una entrada rota no puede
    invalidar la playlist entera); una clave que no es un nombre de archivo
    posible se queda: `validate_key` es cosa de la API, no del merge. Lo que
    no es un campo conocido se guarda en `extra` para devolverlo tal cual.
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
        description=_text(raw, "description"),
        cover_key=_text(raw, "cover_key"),
        folder_id=_text(raw, "folder_id"),
        is_folder=raw.get("is_folder") is True,
        extra={k: v for k, v in raw.items() if k not in _KNOWN},
    )


def _playlist_to_dict(playlist: Playlist) -> dict:
    """JSON de una playlist. Los campos aditivos se omiten si estan vacios:
    una playlist sin ellos produce los MISMOS bytes que antes del cambio.
    Los campos conocidos ganan siempre a `extra`, asi una clave desconocida
    llamada "name" no puede suplantar el nombre real.
    """
    out = dict(playlist.extra)
    out.update({
        "id": playlist.id,
        "name": playlist.name,
        "keys": list(playlist.keys),
        "updated_at": playlist.updated_at,
        "deleted": playlist.deleted,
    })
    if playlist.description:
        out["description"] = playlist.description
    if playlist.cover_key:
        out["cover_key"] = playlist.cover_key
    if playlist.folder_id:
        out["folder_id"] = playlist.folder_id
    if playlist.is_folder:
        out["is_folder"] = True
    return out


@dataclass
class PlaylistBook:
    """Todas las playlists de UN dispositivo. `playlists` va por id.

    Mantiene un indice en memoria `clave -> ids de playlist` (P-large-library-
    scale-10). Se reconstruye SOLO cuando el libro cambia: borrar una cancion
    consulta los dueños de las claves borradas en vez de recorrer todas las
    listas en cada borrado.
    """

    playlists: dict[str, Playlist] = field(default_factory=dict)
    version: int = VERSION
    #: No se serializa; se reconstruye al leer y en cada escritura.
    _owners: dict[str, set[str]] = field(
        default_factory=dict, repr=False, compare=False)

    def __post_init__(self) -> None:
        self._reindex()

    def _reindex(self) -> None:
        owners: dict[str, set[str]] = {}
        for pid, playlist in self.playlists.items():
            if playlist.deleted:
                continue
            for key in playlist.keys:
                owners.setdefault(key, set()).add(pid)
            # Una portada borrada no puede quedar colgada: tambien es una clave.
            if playlist.cover_key:
                owners.setdefault(playlist.cover_key, set()).add(pid)
        self._owners = owners

    def owners(self, keys) -> set[str]:
        """Ids de las listas vivas que contienen alguna de `keys`."""
        out: set[str] = set()
        for key in keys:
            out.update(self._owners.get(key, ()))
        return out

    def to_bytes(self) -> bytes:
        """JSON UTF-8 con claves ordenadas: bytes ESTABLES para comparar."""
        payload = {
            "version": self.version,
            "playlists": [_playlist_to_dict(self.playlists[k])
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
        found: dict[str, Playlist] = {}
        for raw in payload.get("playlists", []):
            playlist = _playlist_from_dict(raw)
            if playlist is None:
                continue
            found[playlist.id] = playlist
        # Un solo reindexado, aunque haya miles de listas.
        return cls(playlists=found)

    def upsert(self, playlist: Playlist) -> None:
        self.playlists[playlist.id] = playlist
        self._reindex()

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
                current, deleted=True, keys=[], updated_at=now,
                cover_key="")
        self._reindex()

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
        merged._reindex()
        return merged


def _entry_ok(entry: str) -> bool:
    """Una entrada es una clave de archivo o el id de una cancion guardada."""
    try:
        validate_key(entry)
        return True
    except ValueError:
        pass
    try:
        saved.validate_song_id(entry)
        return True
    except ValueError:
        return False


def validate_playlist_meta(description: object = "", cover_key: object = "",
                           folder_id: object = "",
                           is_folder: object = False) -> tuple[str, str, str, bool]:
    """Campos aditivos de una playlist. Valores por defecto si no vienen.

    Levanta `ValueError` con un mensaje corto en castellano. `cover_key` tiene
    que ser una clave de archivo; `folder_id`, el id de otra playlist.
    """
    if description is None:
        description = ""
    if not isinstance(description, str):
        raise ValueError("la descripcion tiene que ser texto")
    if len(description) > MAX_DESC_LEN:
        raise ValueError("la descripcion es demasiado larga")
    if cover_key is None:
        cover_key = ""
    if not isinstance(cover_key, str) or (cover_key and not _valid_file_key(cover_key)):
        raise ValueError("la portada tiene que ser una clave de la biblioteca")
    if folder_id is None:
        folder_id = ""
    if not isinstance(folder_id, str) or (folder_id and not _ID_RE.match(folder_id)):
        raise ValueError("la carpeta tiene que ser una playlist")
    if not isinstance(is_folder, bool):
        raise ValueError("is_folder tiene que ser verdadero o falso")
    return description, cover_key, folder_id, is_folder


def _valid_file_key(key: str) -> bool:
    try:
        validate_key(key)
    except ValueError:
        return False
    return True


def validate_playlist(playlist_id: str, name: object, keys: object,
                      *, is_folder: bool = False) -> tuple[str, list[str]]:
    """Valida lo que llega por la API y devuelve `(nombre limpio, claves)`.

    El nombre se recorta; las claves repetidas se descartan conservando la
    primera aparicion (el orden de la playlist es lo que el usuario eligio).
    Ademas de claves de archivo se aceptan ids de canciones guardadas: todo lo
    que suena desde una lista tiene que estar en la biblioteca, bajado o no.
    En una carpeta las entradas son IDs de playlist, no claves de cancion.
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
        ok = bool(_ID_RE.match(key)) if is_folder else _entry_ok(key)
        if not ok:
            raise ValueError(
                "las entradas tienen que ser ids de playlist"
                if is_folder else
                "las entradas tienen que ser claves o ids de cancion")
        if key in seen:
            continue
        seen.add(key)
        out.append(key)
    return clean, out
