"""Instantanea de `/api/library` persistida en SQLite.

El primer `/api/library` de un arranque no espera al escaneo completo: se sirve
de esta instantanea (de la sesion anterior, o vacia la primera vez) mientras el
escaneo corre en segundo plano. El frontend pinta su espejo de localStorage
mientras tanto y pide de nuevo cuando el body viene marcado como pendiente.

Guardar los dos cuerpos (compacto y clasico) con sus ETags evita reconstruirlos
en el camino caliente y mantiene las URLs y sus caches independientes.
"""
from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

log = logging.getLogger(__name__)

DB_FILE = "library-snapshot.sqlite3"

_CREATE = """
CREATE TABLE IF NOT EXISTS snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    signature TEXT NOT NULL,
    describe TEXT NOT NULL,
    body_files BLOB NOT NULL,
    etag_files TEXT NOT NULL,
    body_compact BLOB NOT NULL,
    etag_compact TEXT NOT NULL
)
"""


class SnapshotStore:
    """Una sola fila con la ultima biblioteca escaneada."""

    def __init__(self, data_dir: Path) -> None:
        self.db = Path(data_dir) / DB_FILE

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(str(self.db), timeout=30)

    def load(self) -> dict | None:
        conn = None
        try:
            self.db.parent.mkdir(parents=True, exist_ok=True)
            conn = self._connect()
            with conn:
                conn.execute(_CREATE)
            fila = conn.execute(
                "SELECT signature, describe, body_files, etag_files, "
                "body_compact, etag_compact FROM snapshot WHERE id = 1"
            ).fetchone()
            if fila is None:
                return None
            return {"signature": fila[0], "describe": fila[1],
                    "body_files": bytes(fila[2]), "etag_files": fila[3],
                    "body_compact": bytes(fila[4]), "etag_compact": fila[5]}
        except (OSError, sqlite3.Error, ValueError) as exc:
            log.info("no se pudo leer la instantanea de la biblioteca: %s", exc)
            return None
        finally:
            if conn is not None:
                conn.close()

    def save(self, data: dict) -> None:
        conn = None
        try:
            self.db.parent.mkdir(parents=True, exist_ok=True)
            conn = self._connect()
            with conn:
                conn.execute(_CREATE)
                conn.execute(
                    "INSERT OR REPLACE INTO snapshot "
                    "(id, signature, describe, body_files, etag_files, "
                    "body_compact, etag_compact) VALUES (1, ?, ?, ?, ?, ?, ?)",
                    (data["signature"], data["describe"],
                     data["body_files"], data["etag_files"],
                     data["body_compact"], data["etag_compact"]))
        except (OSError, sqlite3.Error, ValueError) as exc:
            log.info("no se pudo guardar la instantanea de la biblioteca: %s", exc)
        finally:
            if conn is not None:
                conn.close()
