"""Artistas descartados de Discover (roadmap sesion 23).

`descartar` es un toggle, no un evento, y sigue el mismo modelo que las
playlists y el historial: cada dispositivo escribe SOLO su archivo y la vista
se arma mergeando todos.

    discover-<device>.json   {"version": 1, "dismissed": {<folded>: {...}}}

Cada entrada es `{name, at, undone}`. Gana el `at` mas nuevo por artista, asi
que deshacer en un dispositivo tambien borra el descarte en los demas.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field

from .artistinfo import fold

log = logging.getLogger(__name__)

VERSION = 1

DISCOVER_PREFIX = "discover-"
_DISCOVER_FILE_RE = re.compile(
    r"^" + re.escape(DISCOVER_PREFIX) + r"(?P<dev>.+)\.json$")


class DiscoverFormatError(ValueError):
    """El `discover-*` remoto no tiene el formato que se entiende."""


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _entry_from_storage(raw: object) -> dict | None:
    if not isinstance(raw, dict):
        return None
    name = raw.get("name")
    at = _number(raw.get("at"))
    undone = raw.get("undone", False)
    if not isinstance(name, str) or not name.strip():
        return None
    if at is None or at < 0 or not isinstance(undone, bool):
        return None
    return {"name": name.strip(), "at": at, "undone": undone}


def discover_file(device: str) -> str:
    return f"{DISCOVER_PREFIX}{device}.json"


def parse_discover_file(name: str) -> str | None:
    """Device id desde `discover-<dev>.json`, o None."""
    found = _DISCOVER_FILE_RE.match(name)
    return found.group("dev") if found else None


@dataclass
class DiscoverBook:
    """Descartes de UN dispositivo. El merge gana por `at`."""

    dismissed: dict[str, dict] = field(default_factory=dict)
    version: int = VERSION

    def to_bytes(self) -> bytes:
        payload = {"version": self.version,
                   "dismissed": {key: self.dismissed[key]
                                 for key in sorted(self.dismissed)}}
        return json.dumps(payload, sort_keys=True,
                          ensure_ascii=False).encode("utf-8")

    @classmethod
    def from_bytes(cls, data: bytes) -> "DiscoverBook":
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise DiscoverFormatError("discover no es JSON valido") from exc
        if not isinstance(payload, dict):
            raise DiscoverFormatError("discover no es un objeto JSON")
        if payload.get("version") != VERSION:
            raise DiscoverFormatError(
                f"version de discover desconocida: {payload.get('version')!r}")
        dismissed = payload.get("dismissed")
        if not isinstance(dismissed, dict):
            raise DiscoverFormatError("discover no trae dismissed")
        clean = {}
        for key, raw in dismissed.items():
            entry = _entry_from_storage(raw)
            if isinstance(key, str) and key and entry:
                clean[key] = entry
        return cls(dismissed=clean)

    def merged(self, other: "DiscoverBook") -> "DiscoverBook":
        out = dict(self.dismissed)
        for key, entry in other.dismissed.items():
            old = out.get(key)
            if old is None or entry.get("at", 0) > old.get("at", 0):
                out[key] = entry
        return DiscoverBook(dismissed=out)

    def dismissed_set(self) -> set[str]:
        """Nombres plegados que siguen descartados (los `undone` no cuentan)."""
        return {key for key, entry in self.dismissed.items()
                if not entry.get("undone")}


class DiscoverStorageMixin:
    """Lectura-modificacion-escritura de `discover-<device>.json`."""

    # ------------------------------------------------------------- hooks
    def _discover_device(self) -> str:
        raise NotImplementedError

    def _discover_list(self) -> list[tuple[str, str]]:
        """`(ref, name)` de los archivos `discover-*`."""
        raise NotImplementedError

    def _discover_read(self, ref: str) -> bytes:
        raise NotImplementedError

    def _discover_write(self, name: str, data: bytes,
                        ref: str | None = None) -> str:
        """Crea (ref None) o reemplaza y devuelve la ref nueva."""
        raise NotImplementedError

    # ------------------------------------------------------------ internos
    def _discover_lock(self) -> threading.RLock:
        lock = getattr(self, "_discover_mutex", None)
        if lock is None:
            lock = threading.RLock()
            self._discover_mutex = lock
        return lock

    def _read_own_discover(self, ref: str | None) -> DiscoverBook:
        if ref is None:
            return DiscoverBook()
        try:
            return DiscoverBook.from_bytes(self._discover_read(ref))
        except Exception as exc:  # red o formato: no se pisa a ciegas
            raise RuntimeError(
                "no se pudo leer el discover propio: no se sobrescribe"
            ) from exc

    # -------------------------------------------------------------- publico
    def load_discover(self) -> DiscoverBook:
        """Merge de los descartes de todos los dispositivos."""
        with self._discover_lock():
            merged = DiscoverBook()
            for ref, name in self._discover_list():
                if parse_discover_file(name) is None:
                    continue
                try:
                    book = DiscoverBook.from_bytes(self._discover_read(ref))
                except Exception as exc:
                    log.warning("discover ilegible %s: %s", name, exc)
                    continue
                merged = merged.merged(book)
            return merged

    def dismiss_artist(self, name: str, undo: bool = False,
                       now: float | None = None) -> None:
        """Descarta (o deshace) un artista y lo escribe en el archivo propio.

        `at` siempre crece respecto del merge de todos los dispositivos: un
        reloj que retrocede no pierde el cambio contra una copia vieja.
        """
        folded = fold(name)
        if not folded:
            raise ValueError("el nombre del artista no puede estar vacio")
        stamp = float(now if now is not None else time.time())
        device = self._discover_device()
        file_name = discover_file(device)
        with self._discover_lock():
            previous = self.load_discover().dismissed.get(folded)
            at = (max(stamp, previous["at"] + 0.001)
                  if previous is not None else stamp)
            files = {file: ref for ref, file in self._discover_list()}
            ref = files.get(file_name)
            book = self._read_own_discover(ref)
            book.dismissed[folded] = {"name": name.strip(), "at": at,
                                      "undone": bool(undo)}
            self._discover_write(file_name, book.to_bytes(), ref)
