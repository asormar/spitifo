"""Ajuste de almacenamiento activo (que la pantalla de conexion escribe).

Antes el unico modo de elegir donde vive la biblioteca era la variable
`SPITIFO_STORAGE`. La UI necesita cambiarlo en caliente y que sobreviva al
reinicio, asi que el valor vive en `<data_dir>/storage.json`:

    {"active": "google"}

Modulo neutral: no importa starlette ni uvicorn. `data_dir` se inyecta en los
tests para no tocar el directorio real del usuario.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

#: Valores aceptados. Cualquier otro se rechaza al escribir y se ignora al leer.
LOCAL = "local"
GOOGLE = "google"
KNOWN = (LOCAL, GOOGLE)

#: Archivo dentro del directorio de datos.
STORAGE_FILE = "storage.json"


def _config_path(data_dir: Path | None) -> Path:
    """Ruta del `storage.json`. Sin `data_dir`, el directorio del usuario."""
    if data_dir is None:
        # Import perezoso: evita un ciclo con tokens, que importa oauth.
        from .tokens import default_data_dir
        data_dir = default_data_dir()
    return Path(data_dir) / STORAGE_FILE


def active_storage(data_dir: Path | None = None) -> str:
    """Almacenamiento activo: `local` o `google`.

    Falta el archivo, esta corrupto o trae un valor desconocido -> `local`: la
    biblioteca en este dispositivo es el default y el peor caso es no perder
    acceso a la musica.
    """
    try:
        data = json.loads(_config_path(data_dir).read_text("utf-8"))
    except (OSError, ValueError):
        return LOCAL
    if isinstance(data, dict) and data.get("active") in KNOWN:
        return str(data["active"])
    return LOCAL


def set_active_storage(name: str, data_dir: Path | None = None) -> None:
    """Guarda el almacenamiento activo, atomico (temporal + `os.replace`)."""
    if name not in KNOWN:
        raise ValueError(f"almacenamiento desconocido: {name!r} (usar {KNOWN})")
    path = _config_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".storage-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"active": name}, f)
        # `os.replace` es atomico en el mismo volumen: nunca se lee a medias.
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
