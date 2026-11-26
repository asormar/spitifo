"""Cache de duracion y etiquetas del adapter local, en SQLite.

Antes vivia en un `media-cache.json` que se reescribia entero en cada listado
(P-large-library-scale-7). Aqui cada ficha es una fila y un listado solo hace
upserts de lo que cambio y borra las claves que desaparecieron: con miles de
pistas eso evita serializar y volver a escribir todo el archivo.

La migracion del JSON viejo es de una sola vez y aguanta un corte: las filas se
insertan y la marca de version se escribe en la MISMA transaccion; el JSON no se
retira hasta que esa transaccion confirmo. Si el proceso se corta antes, la
proxima apertura no ve la marca y repite la migracion con `INSERT OR REPLACE`,
que es idempotente. El archivo viejo nunca se borra si la migracion fallo.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import time
from pathlib import Path

log = logging.getLogger(__name__)

DB_FILE = "media-cache.sqlite3"
LEGACY_FILE = "media-cache.json"
#: v2 era el formato JSON; v3 es esta base.
VERSION = 3

#: Orden de las columnas de cada ficha (compartido con `local.py`).
FIELDS = ("size", "mtime", "duration", "title", "artist", "album",
          "track_no", "disc_no", "album_id")

_CREATE = """
CREATE TABLE IF NOT EXISTS media (
    key TEXT PRIMARY KEY,
    size INTEGER,
    mtime REAL,
    duration REAL,
    title TEXT,
    artist TEXT,
    album TEXT,
    track_no INTEGER,
    disc_no INTEGER,
    album_id TEXT
)
"""
_INSERT = (
    "INSERT OR REPLACE INTO media "
    "(key, size, mtime, duration, title, artist, album, track_no, disc_no, "
    "album_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


def _row(key: str, ficha: dict) -> tuple:
    return (key, *(ficha.get(n) for n in FIELDS))


class MediaCache:
    """Fichas de media persistidas en `<state_dir>/media-cache.sqlite3`."""

    def __init__(self, state_dir: Path) -> None:
        self.db = Path(state_dir) / DB_FILE
        self.legacy = Path(state_dir) / LEGACY_FILE

    def _connect(self) -> sqlite3.Connection:
        # Una conexion por operacion: la cache se usa desde el pool de storage
        # y cada hilo tiene la suya. SQLite se encarga del candado del archivo.
        return sqlite3.connect(str(self.db), timeout=30)

    def _descartar(self) -> None:
        """Aparta una base ilegible para que la proxima operacion la rehaga."""
        try:
            self.db.rename(self.db.with_name(
                f"{DB_FILE}.corrupt-{int(time.time() * 1000)}"))
        except OSError:
            try:
                self.db.unlink()
            except OSError:
                pass

    def _ensure(self, conn: sqlite3.Connection) -> None:
        conn.execute(_CREATE)
        conn.execute("CREATE TABLE IF NOT EXISTS meta "
                     "(k TEXT PRIMARY KEY, v TEXT)")

    def _version(self, conn: sqlite3.Connection) -> str | None:
        fila = conn.execute("SELECT v FROM meta WHERE k = 'version'").fetchone()
        return fila[0] if fila else None

    def _migrate(self, conn: sqlite3.Connection) -> None:
        """Pasa el JSON viejo a la base. Idempotente y con un solo commit."""
        fichas: dict = {}
        try:
            payload = json.loads(self.legacy.read_text("utf-8"))
            if (isinstance(payload, dict)
                    and payload.get("version") == 2
                    and isinstance(payload.get("files"), dict)):
                fichas = {k: v for k, v in payload["files"].items()
                          if isinstance(v, dict)}
        except (OSError, ValueError):
            fichas = {}
        with conn:
            conn.executemany(_INSERT, (_row(k, v) for k, v in fichas.items()))
            conn.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)",
                         ("version", str(VERSION)))
        # Solo despues del commit: si hubo un corte, el JSON sigue ahi para la
        # proxima vez. Renombrar (no borrar) deja la evidencia de la migracion.
        if fichas:
            try:
                self.legacy.rename(self.legacy.with_suffix(".json.migrated"))
            except OSError as exc:
                log.info("no se pudo retirar la cache JSON migrada: %s", exc)

    def load(self) -> dict[str, dict]:
        """Todas las fichas, o `{}` si no hay base o no se puede leer."""
        for intento in (0, 1):
            conn = None
            try:
                self.db.parent.mkdir(parents=True, exist_ok=True)
                conn = self._connect()
                with conn:
                    self._ensure(conn)
                    if self._version(conn) != str(VERSION):
                        self._migrate(conn)
                    filas = conn.execute(
                        "SELECT key, size, mtime, duration, title, artist, "
                        "album, track_no, disc_no, album_id FROM media").fetchall()
                return {f[0]: dict(zip(FIELDS, f[1:])) for f in filas}
            except sqlite3.DatabaseError as exc:
                log.warning("cache de media ilegible, se rehace: %s", exc)
                if conn is not None:
                    conn.close()
                    conn = None
                self._descartar()
            except (OSError, ValueError) as exc:
                # Sin cache la biblioteca solo es mas lenta: nunca rompe el
                # listado.
                log.warning("no se pudo leer la cache de media: %s", exc)
                return {}
            finally:
                if conn is not None:
                    conn.close()
        return {}

    def apply(self, upserts: dict[str, dict], gone: set[str]) -> None:
        """Escribe lo cambiado y olvida lo borrado, en una sola transaccion."""
        if not upserts and not gone:
            return
        for intento in (0, 1):
            conn = None
            try:
                conn = self._connect()
                with conn:
                    self._ensure(conn)
                    # Una base recien creada todavia no tiene la marca: migrar
                    # primero para no pisar fichas del JSON con datos nuevos.
                    if self._version(conn) != str(VERSION):
                        self._migrate(conn)
                    if upserts:
                        conn.executemany(
                            _INSERT, (_row(k, v) for k, v in upserts.items()))
                    if gone:
                        conn.executemany("DELETE FROM media WHERE key = ?",
                                         ((k,) for k in gone))
                return
            except sqlite3.DatabaseError as exc:
                log.warning("cache de media ilegible, se rehace: %s", exc)
                if conn is not None:
                    conn.close()
                    conn = None
                self._descartar()
            except (OSError, ValueError) as exc:
                log.warning("no se pudo guardar la cache de media: %s", exc)
                return
            finally:
                if conn is not None:
                    conn.close()
