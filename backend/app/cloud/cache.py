"""Cache offline de audio: archivos completos bajo un presupuesto de tamano.

Se guarda el archivo ENTERO, nunca fragmentos, con el nombre derivado de
`(remote_id, revision)`. La eviction es LRU y jamas toca lo que el usuario bajo
a proposito (`pin`). Es igual para cualquier proveedor
(docs/adr/0002-user-owned-storage.md, secciones 5 y 7).

Modulo neutral: no importa starlette ni uvicorn.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

#: Nombre del archivo de metadata dentro de la raiz de la cache.
INDEX_NAME = "index.json"


class AudioCache:
    """Cache de archivos completos con metadata LRU en `index.json`."""

    def __init__(self, root: Path, budget_bytes: int,
                 clock: Callable[[], float] | None = None) -> None:
        self.root = Path(root)
        self.budget_bytes = int(budget_bytes)
        # Reloj inyectable: los tests controlan el orden LRU sin dormir.
        self._clock = clock or time.time
        self._lock = threading.Lock()
        self._index: dict[str, dict] = {}
        self.root.mkdir(parents=True, exist_ok=True)
        self._load()

    # ------------------------------------------------------------- internos
    @staticmethod
    def _key(remote_id: str, revision: str) -> str:
        """sha256 de `remote_id + NUL + revision`: un archivo por revision."""
        return hashlib.sha256(
            f"{remote_id}\0{revision}".encode("utf-8")).hexdigest()

    @staticmethod
    def _ext(ext: str) -> str:
        if not ext:
            return ""
        return ext if ext.startswith(".") else "." + ext

    def _file(self, key: str, ext: str) -> Path:
        return self.root / (key + ext)

    def _load(self) -> None:
        """Lee `index.json`; si falta o esta corrupto, arranca vacio y limpia."""
        try:
            raw = json.loads((self.root / INDEX_NAME).read_text("utf-8"))
            entries = raw["entries"]
            if not isinstance(entries, dict):
                raise ValueError("`entries` no es un objeto")
            clean: dict[str, dict] = {}
            for key, ent in entries.items():
                if not isinstance(ent, dict):
                    continue
                clean[str(key)] = {
                    "ext": str(ent.get("ext", "")),
                    "touched": float(ent.get("touched", 0.0)),
                    "pinned": bool(ent.get("pinned", False)),
                    "size": int(ent.get("size", 0)),
                }
            # Una entrada sin archivo detras es basura: se descarta.
            for key in list(clean):
                if not self._file(key, clean[key]["ext"]).is_file():
                    del clean[key]
            self._index = clean
        except Exception:
            # Metadata faltante o corrupta: se arranca vacio. Todo archivo que
            # habia queda huerfano (nadie lo reclama) y se borra abajo.
            self._index = {}
        # Tambien con un indice sano: un corte entre copiar el archivo y
        # guardar el indice deja un archivo (o un `.part`) que nadie reclama.
        self._remove_orphans()

    def _save(self) -> None:
        payload = json.dumps({"entries": self._index}, sort_keys=True)
        fd, tmp = tempfile.mkstemp(dir=self.root, prefix=".index-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(payload)
            os.replace(tmp, self.root / INDEX_NAME)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def _remove_orphans(self) -> None:
        """Borra archivos que el indice no reclama (metadata reconstruida)."""
        try:
            files = list(self.root.iterdir())
        except OSError:
            return
        claimed = {key + ent["ext"] for key, ent in self._index.items()}
        for p in files:
            if p.name == INDEX_NAME or p.name in claimed or not p.is_file():
                continue
            try:
                p.unlink()
            except OSError:
                pass

    def _drop_missing(self) -> None:
        for key in list(self._index):
            if not self._file(key, self._index[key]["ext"]).is_file():
                del self._index[key]

    def _total(self) -> int:
        return sum(ent["size"] for ent in self._index.values())

    def _evict_locked(self, keep: str | None = None) -> None:
        """Saca lo menos usado recientemente hasta entrar en el presupuesto.

        `keep` es la entrada recien guardada: `put` devuelve su ruta, asi que
        no puede borrarla aunque sola supere el presupuesto.
        """
        self._drop_missing()
        total = self._total()
        if total <= self.budget_bytes:
            return
        for key, ent in sorted(self._index.items(),
                               key=lambda kv: kv[1]["touched"]):
            if total <= self.budget_bytes:
                break
            if ent["pinned"] or key == keep:
                # Lo que el usuario bajo es sagrado: nunca se evicta.
                continue
            try:
                self._file(key, ent["ext"]).unlink()
            except OSError:
                pass
            total -= ent["size"]
            del self._index[key]

    # ---------------------------------------------------------------- puerto
    def get(self, remote_id: str, revision: str) -> Path | None:
        """Ruta cacheada o None. Si existe, la marca como la ultima usada."""
        with self._lock:
            key = self._key(remote_id, revision)
            ent = self._index.get(key)
            if ent is None:
                return None
            path = self._file(key, ent["ext"])
            if not path.is_file():
                del self._index[key]
                self._save()
                return None
            ent["touched"] = self._clock()
            self._save()
            return path

    def put(self, remote_id: str, revision: str, src: Path,
            ext: str) -> Path:
        """Copia `src` a la cache de forma atomica, luego evicta si hace falta."""
        with self._lock:
            key = self._key(remote_id, revision)
            ext = self._ext(ext)
            dest = self._file(key, ext)
            tmp = self.root / f"{key}{ext}.part"
            try:
                shutil.copyfile(src, tmp)
                os.replace(tmp, dest)
            except BaseException:
                try:
                    tmp.unlink()
                except OSError:
                    pass
                raise
            prev = self._index.get(key)
            if prev is not None and prev["ext"] != ext:
                # Misma revision, otra extension: el archivo viejo es huerfano.
                try:
                    self._file(key, prev["ext"]).unlink()
                except OSError:
                    pass
            self._index[key] = {
                "ext": ext,
                "touched": self._clock(),
                "pinned": bool(prev["pinned"]) if prev else False,
                "size": dest.stat().st_size,
            }
            self._evict_locked(keep=key)
            self._save()
            return dest

    def pin(self, remote_id: str, revision: str) -> None:
        """Marca la entrada como bajada por el usuario: no se evicta."""
        with self._lock:
            ent = self._index.get(self._key(remote_id, revision))
            if ent is None:
                return
            ent["pinned"] = True
            self._save()

    def unpin(self, remote_id: str, revision: str) -> None:
        with self._lock:
            ent = self._index.get(self._key(remote_id, revision))
            if ent is None:
                return
            ent["pinned"] = False
            self._save()

    def evict(self) -> None:
        """Aplica el presupuesto ahora (por si `budget_bytes` bajo)."""
        with self._lock:
            self._evict_locked()
            self._save()

    def size(self) -> int:
        with self._lock:
            self._drop_missing()
            return self._total()


def default_cache_dir() -> Path:
    """Directorio de cache del usuario, segun el SO."""
    override = os.getenv("SPITIFO_CACHE_DIR")
    if override:
        return Path(override)
    if sys.platform == "win32":
        local = os.getenv("LOCALAPPDATA")
        if local:
            return Path(local) / "Spitifo" / "cache"
    return Path.home() / ".cache" / "spitifo"
