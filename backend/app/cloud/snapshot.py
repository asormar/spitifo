"""Copia local de los archivos chicos de la nube, para arrancar rapido.

Cada dispositivo escribe sus `index-*`, `playlists-*`, `listens-*`... y todos
los demas los leen enteros. Bajarlos uno por uno en cada arranque cuesta ~0.5 s
cada uno en Drive. Esta copia guarda, por archivo remoto, el id, el nombre, un
`stamp` (la version que informa el proveedor: cambia si cambia el contenido) y
los bytes. Con el listado (una sola request, barata) se sabe que archivos
cambiaron y solo esos se vuelven a bajar.

Tambien recuerda los ids de carpeta ya resueltos (`Spitifo`, `Spitifo/Artista`):
buscarlos de nuevo son requests secuenciales en cada arranque.

Formato, una carpeta por biblioteca (proveedor + carpeta raiz):

    <data_dir>/snapshots/<proveedor>-<hash>/state.json
    <data_dir>/snapshots/<proveedor>-<hash>/files/<hash-del-id>.bin

`state.json` = `{"v": 1, "folders": {"": id, ...}, "files": {remote_id:
{"name", "prefix", "stamp", "size", "sha256"}}}`. Los `.bin` son los bytes tal
cual. NUNCA se guardan tokens ni credenciales: solo ids, nombres, versiones y el
contenido de los archivos de la biblioteca.

Es una optimizacion, jamas una fuente de verdad: una copia ilegible, a medias o
con otro formato se ignora y se vuelve a bajar de la nube. Cada lectura verifica
tamano y sha256, asi que dos procesos escribiendo a la vez o un disco corrupto
solo producen un fallo de cache, nunca bytes equivocados.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import NamedTuple

log = logging.getLogger(__name__)

SNAPSHOT_VERSION = 1
STATE_FILE = "state.json"
FILES_DIR = "files"


class RemoteFile(NamedTuple):
    """Un archivo chico del proveedor, tal como lo informa el listado.

    `stamp` es opaco: el proveedor lo arma con lo que cambia cuando cambia el
    contenido (en Drive, `modifiedTime|version|size`). Vacio = el proveedor no
    informa version y el archivo nunca se reusa de la copia local.
    """

    remote_id: str
    name: str
    stamp: str = ""


def snapshot_dir(data_dir: Path, kind: str, folder_name: str) -> Path:
    """Carpeta de la copia de UNA biblioteca (proveedor + carpeta raiz)."""
    digest = hashlib.sha256(folder_name.encode("utf-8")).hexdigest()[:10]
    return Path(data_dir) / "snapshots" / f"{kind}-{digest}"


def _atomic_write(path: Path, data: bytes) -> None:
    """Temporal en la misma carpeta + `os.replace`: nunca se lee a medias."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".snap-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _valid_entry(entry: object) -> bool:
    return (isinstance(entry, dict)
            and all(isinstance(entry.get(k), str)
                    for k in ("name", "prefix", "stamp", "sha256"))
            and isinstance(entry.get("size"), int)
            and not isinstance(entry.get("size"), bool))


class SmallFileSnapshot:
    """Copia local de archivos chicos remotos y de ids de carpeta. Thread-safe."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        self._lock = threading.RLock()
        self._folders: dict[str, str] = {}
        self._files: dict[str, dict] = {}
        self._dirty = False
        self._load()

    # ------------------------------------------------------------- disco
    def _bin_path(self, remote_id: str) -> Path:
        name = hashlib.sha256(remote_id.encode("utf-8")).hexdigest()[:32]
        return self.directory / FILES_DIR / f"{name}.bin"

    def _load(self) -> None:
        """Lee `state.json`. Cualquier problema = copia vacia (como si no hubiera)."""
        try:
            raw = json.loads((self.directory / STATE_FILE).read_text("utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(raw, dict) or raw.get("v") != SNAPSHOT_VERSION:
            return
        folders = raw.get("folders")
        if isinstance(folders, dict):
            self._folders = {k: v for k, v in folders.items()
                             if isinstance(k, str) and isinstance(v, str) and v}
        files = raw.get("files")
        if isinstance(files, dict):
            self._files = {k: dict(v) for k, v in files.items()
                           if isinstance(k, str) and _valid_entry(v)}

    def save(self) -> None:
        """Escribe `state.json` si algo cambio. Un fallo de disco solo se loguea."""
        with self._lock:
            if not self._dirty:
                return
            payload = {"v": SNAPSHOT_VERSION, "folders": self._folders,
                       "files": self._files}
            try:
                _atomic_write(self.directory / STATE_FILE,
                              json.dumps(payload).encode("utf-8"))
            except OSError as exc:
                log.warning("no se pudo guardar la copia local: %s", exc)
                return
            self._dirty = False

    # ----------------------------------------------------------- carpetas
    def folders(self) -> dict[str, str]:
        with self._lock:
            return dict(self._folders)

    def set_folders(self, folders: dict[str, str]) -> None:
        with self._lock:
            clean = {k: v for k, v in folders.items() if k is not None and v}
            if clean == self._folders:
                return
            self._folders = clean
            self._dirty = True
            self.save()

    # ------------------------------------------------------------ archivos
    def get(self, remote_id: str, stamp: str) -> bytes | None:
        """Bytes guardados si el `stamp` coincide y el archivo esta sano."""
        if not stamp:
            return None
        with self._lock:
            entry = self._files.get(remote_id)
            if entry is None or entry["stamp"] != stamp:
                return None
            path = self._bin_path(remote_id)
        try:
            data = path.read_bytes()
        except OSError:
            data = None
        if (data is None or len(data) != entry["size"]
                or hashlib.sha256(data).hexdigest() != entry["sha256"]):
            log.warning("copia local danada para %s: se vuelve a bajar",
                        entry["name"])
            self.discard(remote_id)
            return None
        return data

    def put(self, remote_id: str, name: str, prefix: str, stamp: str,
            data: bytes) -> None:
        """Guarda los bytes. No escribe `state.json`: eso es `save()`."""
        if not stamp:
            return
        try:
            _atomic_write(self._bin_path(remote_id), data)
        except OSError as exc:
            log.warning("no se pudo guardar %s en la copia local: %s", name, exc)
            self.discard(remote_id)
            return
        with self._lock:
            self._files[remote_id] = {
                "name": name, "prefix": prefix, "stamp": stamp,
                "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            self._dirty = True

    def discard(self, remote_id: str) -> None:
        with self._lock:
            if self._files.pop(remote_id, None) is None:
                return
            self._dirty = True
            path = self._bin_path(remote_id)
        try:
            path.unlink()
        except OSError:
            pass

    def prune(self, prefix: str, keep: set[str]) -> None:
        """Olvida los archivos de `prefix` que el listado ya no trae."""
        with self._lock:
            gone = [rid for rid, entry in self._files.items()
                    if entry["prefix"] == prefix and rid not in keep]
        for remote_id in gone:
            self.discard(remote_id)

    def entries(self) -> dict[str, dict]:
        """Copia de las entradas (para tests y diagnostico)."""
        with self._lock:
            return {k: dict(v) for k, v in self._files.items()}
