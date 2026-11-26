"""Journal append-only del indice de la biblioteca en la nube.

Una descarga nueva no tendria por que re-subir el indice ENTIERO (2,8 MB a 3000
pistas, ~19 MB a 20000: P-large-library-scale-3). Aca cada cambio del indice
propio se escribe como UNA linea corta en un archivo LOCAL del dispositivo; el
indice de la nube se reescribe solo al compactar.

Formato (NDJSON, una linea por cambio)::

    {"v":1,"n":7,"k":"A/Tema.m4a","e":{...IndexEntry...}}
    {"v":1,"n":8,"k":"A/Viejo.m4a","d":true,"t":1761234567.0}

- `v` version del formato, `n` numero de secuencia (creciente), `k` la clave.
- `e` la entrada completa en un upsert; `d` + `t` un tombstone (borrado).
- Cada linea se escribe con UN `os.write` y un `fsync`, bajo un lock: o entra
  entera o no entra. Una linea a medias (corte de energia) se descarta al leer.

Una version antigua de la app solo lee `index-<device>.json`, asi que el journal
se compacta (se mergea en el indice y se borra) cada `COMPACT_ENTRIES` cambios,
o despues de `COMPACT_AGE_S` segundos con cambios pendientes, o al cerrar la
app. Eso acota lo atrasada que puede estar una version antigua: como maximo
ese numero de cambios / ese tiempo.

 Modulo neutral: no importa starlette ni el adaptador de Drive.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import asdict
from pathlib import Path
from typing import Callable, Iterator

from .library_index import IndexEntry, _entry_from_dict

log = logging.getLogger("spitifo.index_journal")

VERSION = 1

#: Compactar despierto de tantos cambios, o de tanto tiempo con pendientes.
COMPACT_ENTRIES = 50
COMPACT_AGE_S = 300.0

PREFIX = "index-journal-"


def journal_path(data_dir: Path, device_id: str) -> Path:
    """Ruta del journal de un dispositivo, dentro del dir de datos de la app."""
    return Path(data_dir) / f"{PREFIX}{device_id}.jsonl"


def encode(entry: IndexEntry, seq: int) -> bytes:
    """Una linea del journal para un upsert. Termina en salto de linea."""
    payload = {"v": VERSION, "n": seq, "k": entry.key, "e": asdict(entry)}
    return json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8") + b"\n"


def encode_delete(key: str, updated_at: float, seq: int) -> bytes:
    """Una linea del journal para un tombstone."""
    payload = {"v": VERSION, "n": seq, "k": key, "d": True, "t": updated_at}
    return json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8") + b"\n"


def decode(line: bytes) -> tuple[str, IndexEntry | float] | None:
    """Decodifica una linea. None si esta cortada, es de otra version o es basura.

    El segundo elemento es la `IndexEntry` de un upsert o el `updated_at` de un
    borrado (tombstone). Los cambios se aplican siempre en orden de secuencia.
    """
    try:
        raw = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(raw, dict) or raw.get("v") != VERSION:
        return None
    key = raw.get("k")
    if not isinstance(key, str) or not key:
        return None
    if raw.get("d") is True:
        try:
            return key, float(raw.get("t", 0.0))
        except (TypeError, ValueError):
            return None
    entry = _entry_from_dict(raw.get("e"))
    if entry is None or entry.key != key:
        return None
    return key, entry


def _lines(path: Path) -> Iterator[tuple[int, tuple[str, IndexEntry | float]]]:
    """Lineas validas con su numero de secuencia, en orden de aparicion."""
    if not path.is_file():
        return
    data = path.read_bytes()
    for line in data.splitlines():
        parsed = decode(line)
        if parsed is None:
            continue
        key, value = parsed
        try:
            seq = int(json.loads(line.decode("utf-8")).get("n", 0))
        except (ValueError, TypeError):
            seq = 0
        yield seq, (key, value)


class IndexJournal:
    """Journal local de un dispositivo. Todo es sincronico y con lock: lo llama
    el pool de storage, nunca el event loop."""

    def __init__(self, path: Path, *, clock: Callable[[], float] = time.time,
                 compact_entries: int = COMPACT_ENTRIES,
                 compact_age_s: float = COMPACT_AGE_S) -> None:
        self.path = Path(path)
        self._clock = clock
        self._compact_entries = compact_entries
        self._compact_age_s = compact_age_s
        self._lock = threading.Lock()
        self._seq = 0
        self._pending = 0
        self._last_compact = clock()

    def load(self) -> dict[str, IndexEntry]:
        """Estado vigente del journal: la ultima entrada por clave.

        Las lineas rotas al final (corte a mitad de escritura) se ignoran. Un
        journal ilegible no tumba la biblioteca: se registra y se sigue con el
        indice de la nube.
        """
        try:
            changes: dict[str, IndexEntry | float] = {}
            max_seq = 0
            for seq, (key, value) in _lines(self.path):
                changes[key] = value
                max_seq = max(max_seq, seq)
            with self._lock:
                self._seq = max(self._seq, max_seq)
                self._pending = sum(1 for _ in _lines(self.path))
                self._last_compact = self._clock()
            return {k: v for k, v in changes.items() if isinstance(v, IndexEntry)}
        except OSError as exc:
            log.warning("no se pudo leer el journal %s: %s", self.path, exc)
            return {}

    def append(self, entries: list[IndexEntry]) -> None:
        """Agrega upserts, UNA linea por entrada, atomicamente.

        Se abre con O_APPEND y cada linea se manda en un solo `os.write` seguido
        de un `fsync`: dos grupos que terminan juntos no se pueden pisar, y un
        corte entre dos lineas no deja una entrada a medias.
        """
        if not entries:
            return
        with self._lock:
            lines = [encode(e, self._seq + i + 1)
                     for i, e in enumerate(entries)]
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                for line in lines:
                    # Un solo write por registro: el kernel no entrecorta una
                    # llamada pequena en un archivo local en dos escrituras.
                    os.write(fd, line)
                os.fsync(fd)
            finally:
                os.close(fd)
            self._seq += len(lines)
            self._pending += len(lines)

    def append_delete(self, key: str, updated_at: float) -> None:
        """Agrega un tombstone (la contraparte de `LibraryIndex.remove`)."""
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.write(fd, encode_delete(key, updated_at, self._seq + 1))
                os.fsync(fd)
            finally:
                os.close(fd)
            self._seq += 1
            self._pending += 1

    def snapshot(self) -> tuple[dict[str, IndexEntry | float], int]:
        """`(cambios, ultimo_seq)` del journal, sin borrar nada.

        El ultimo seq permite descartar SOLO lo que ya se subio: un cambio que
        llegue mientras se sube el indice queda para la siguiente compactacion.
        """
        changes: dict[str, IndexEntry | float] = {}
        max_seq = 0
        try:
            for seq, (key, value) in _lines(self.path):
                changes[key] = value
                max_seq = max(max_seq, seq)
        except OSError as exc:
            log.warning("no se pudo leer el journal %s: %s", self.path, exc)
        return changes, max_seq

    def drop_applied(self, upto_seq: int) -> None:
        """Saca del journal las lineas con seq <= `upto_seq` (ya subidas).

        Reescribe con replace atomico. Las lineas nuevas que hayan llegado
        mientras subia el indice se conservan: no se pierde ningun cambio.
        """
        with self._lock:
            keep: list[bytes] = []
            if self.path.is_file():
                try:
                    for line in self.path.read_bytes().splitlines(keepends=True):
                        try:
                            seq = int(json.loads(line.decode("utf-8")).get("n", 0))
                        except (ValueError, TypeError, UnicodeDecodeError):
                            # Una linea cortada no se puede haber subido: se
                            # descarta (el lector ya la ignoraba).
                            continue
                        if seq > upto_seq:
                            keep.append(line)
                except OSError as exc:
                    log.warning("no se pudo compactar el journal %s: %s",
                                self.path, exc)
                    return
            tmp = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp.write_bytes(b"".join(keep))
                os.replace(tmp, self.path)
            except OSError as exc:
                log.warning("no se pudo reescribir el journal %s: %s",
                            self.path, exc)
                return
            self._seq = max(self._seq, upto_seq)
            self._pending = len(keep)
            self._last_compact = self._clock()

    def should_compact(self) -> bool:
        """True si ya toca fundir el journal en el indice de la nube."""
        with self._lock:
            if not self._pending:
                return False
            return (self._pending >= self._compact_entries
                    or (self._clock() - self._last_compact) >= self._compact_age_s)

    def clear(self) -> None:
        """Vacia el journal con replace atomico (nunca queda un archivo a medias).

        Se llama DESPUES de subir el indice con todos los cambios aplicados. Si
        el proceso se corta entre las dos cosas, el journal se vuelve a aplicar:
        los upserts son idempotentes (`updated_at` no cambia), asi que no se
        pierde ni se duplica nada.
        """
        with self._lock:
            tmp = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp.write_bytes(b"")
                os.replace(tmp, self.path)
            except OSError as exc:
                log.warning("no se pudo vaciar el journal %s: %s", self.path, exc)
                return
            self._seq = 0
            self._pending = 0
            self._last_compact = self._clock()

    def stats(self) -> dict:
        """Para `/api/storage`: cuantos cambios tiene y que tan atrasada puede
        estar una version antigua que solo lee el indice."""
        with self._lock:
            return {
                "pending": self._pending,
                "compact_after_entries": self._compact_entries,
                "compact_after_seconds": self._compact_age_s,
                "old_client_max_pending": max(self._pending, self._compact_entries),
            }
