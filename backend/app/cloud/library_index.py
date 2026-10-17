"""Indice de la biblioteca (`index.json`) que vive en la carpeta de la nube.

Es la fuente de verdad: key, remote id, revision, titulo, artista, album,
duracion, tamano y formato. El downloader lo escribe; el app companera y otros
dispositivos lo leen, asi nadie lista miles de archivos al arrancar. Las
escrituras son condicionales por revision: ante un conflicto se relee, se
mergea y se reintenta (docs/adr/0002-user-owned-storage.md, seccion 4).

Modulo neutral: no importa starlette ni uvicorn.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, replace
from typing import Callable

from ..storage import InvalidKey, validate_key

#: Version del formato. Un major distinto se rechaza en vez de adivinar.
VERSION = 1


class IndexFormatError(ValueError):
    """El `index.json` remoto no tiene el formato que este backend entiende."""


class PreconditionFailed(Exception):
    """La escritura condicional choco: alguien mas cambio el indice (412)."""


@dataclass(frozen=True)
class IndexEntry:
    """Una pista dentro del indice.

    `deleted` es un tombstone: la pista se borro, pero la entrada se queda para
    que un merge con otro dispositivo no la resucite con una copia vieja.
    """

    key: str
    remote_id: str
    revision: str
    title: str
    artist: str
    album: str
    duration: float | None
    size: int
    format: str
    updated_at: float
    deleted: bool = False


def _entry_from_dict(raw: object) -> IndexEntry | None:
    """Entrada desde JSON. None si le falta algo o viene mal formada."""
    if not isinstance(raw, dict):
        return None
    try:
        duration = raw.get("duration")
        return IndexEntry(
            key=str(raw["key"]),
            remote_id=str(raw.get("remote_id", "")),
            revision=str(raw.get("revision", "")),
            title=str(raw.get("title", "")),
            artist=str(raw.get("artist", "")),
            album=str(raw.get("album", "")),
            duration=None if duration is None else float(duration),
            size=int(raw.get("size", 0)),
            format=str(raw.get("format", "")),
            updated_at=float(raw.get("updated_at", 0.0)),
            deleted=bool(raw.get("deleted", False)),
        )
    except (KeyError, TypeError, ValueError):
        return None


@dataclass
class LibraryIndex:
    """Indice en memoria. `entries` va por clave."""

    entries: dict[str, IndexEntry] = field(default_factory=dict)
    version: int = VERSION

    def to_bytes(self) -> bytes:
        """JSON UTF-8 con claves ordenadas: bytes ESTABLES para comparar."""
        payload = {
            "version": self.version,
            "entries": [asdict(self.entries[k]) for k in sorted(self.entries)],
        }
        return json.dumps(payload, sort_keys=True,
                          ensure_ascii=False).encode("utf-8")

    @classmethod
    def from_bytes(cls, data: bytes) -> LibraryIndex:
        """Reconstruye el indice. Rechaza un major desconocido; salta claves feas."""
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise IndexFormatError("el indice no es JSON valido") from exc
        if not isinstance(payload, dict):
            raise IndexFormatError("el indice no es un objeto JSON")
        if payload.get("version") != VERSION:
            raise IndexFormatError(
                f"version de indice desconocida: {payload.get('version')!r}")
        index = cls()
        for raw in payload.get("entries", []):
            entry = _entry_from_dict(raw)
            if entry is None:
                continue
            try:
                validate_key(entry.key)
            except InvalidKey:
                # Una clave que no puede ser un archivo real se ignora, igual
                # que hace `LocalStorage.list()`.
                continue
            index.entries[entry.key] = entry
        return index

    def upsert(self, entry: IndexEntry) -> None:
        self.entries[entry.key] = entry

    def remove(self, key: str, now: float) -> None:
        """Escribe un tombstone con el `updated_at` nuevo."""
        current = self.entries.get(key)
        if current is None:
            self.entries[key] = IndexEntry(
                key=key, remote_id="", revision="", title="", artist="",
                album="", duration=None, size=0, format="", updated_at=now,
                deleted=True)
        else:
            self.entries[key] = replace(current, deleted=True, updated_at=now)

    def live(self) -> list[IndexEntry]:
        """Las pistas vigentes (sin tombstones), ordenadas por clave."""
        return [self.entries[k] for k in sorted(self.entries)
                if not self.entries[k].deleted]

    def merge(self, other: LibraryIndex) -> LibraryIndex:
        """Por clave gana el `updated_at` mas nuevo. En empate, gana el propio."""
        merged = LibraryIndex(entries=dict(self.entries))
        for key, entry in other.entries.items():
            mine = merged.entries.get(key)
            if mine is None or entry.updated_at > mine.updated_at:
                merged.entries[key] = entry
        return merged


Read = Callable[[], "tuple[LibraryIndex | None, str | None]"]
Write = Callable[[bytes, "str | None"], str]
Change = Callable[[LibraryIndex], None]


def update_index(read: Read, write: Write, change: Change,
                 attempts: int = 5) -> tuple[LibraryIndex, str]:
    """Ciclo leer-cambiar-escribir con reintento ante conflicto (412).

    `read()` devuelve el indice remoto y su revision (`None, None` si todavia
    no existe). `write(body, if_match)` escribe condicional y devuelve la
    revision nueva; ante 412 levanta `PreconditionFailed`. Con `if_match=None`
    el adapter crea SOLO si no existe (`If-None-Match: *` en Graph): dos
    dispositivos creando a la vez no se pisan. Al chocar se RELEE y
    se reaplica `change` sobre la copia fresca, nunca sobre la que ya mutamos.
    """
    for _ in range(attempts):
        index, revision = read()
        if index is None:
            index = LibraryIndex()
        change(index)
        try:
            return index, write(index.to_bytes(), revision)
        except PreconditionFailed:
            continue
    raise PreconditionFailed(
        f"no se pudo escribir el indice tras {attempts} intentos")
