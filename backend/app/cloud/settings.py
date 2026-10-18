"""Ajuste de almacenamiento activo (que la pantalla de conexion escribe).

Antes el unico modo de elegir donde vive la biblioteca era la variable
`SPITIFO_STORAGE`. La UI necesita cambiarlo en caliente y que sobreviva al
reinicio, asi que el valor vive en `<data_dir>/storage.json`:

    {"active": "google", "google_connected": true}

`google_connected` solo lo usa Android (ver `cloud/android.py`): ahi el access
token es de memoria y el shell lo reempuja en cada arranque, asi que lo que dice
si la cuenta esta conectada no puede salir del token. Las dos claves conviven:
escribir una conserva la otra.

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

#: Marca de "hay una cuenta de Google conectada" para quien no puede mirar los
#: tokens: en Android el access token solo vive en memoria y lo empuja Kotlin en
#: cada arranque, asi que lo persistente (y lo que la UI muestra) es esto.
GOOGLE_CONNECTED = "google_connected"


def _config_path(data_dir: Path | None) -> Path:
    """Ruta del `storage.json`. Sin `data_dir`, el directorio del usuario."""
    if data_dir is None:
        # Import perezoso: evita un ciclo con tokens, que importa oauth.
        from .tokens import default_data_dir
        data_dir = default_data_dir()
    return Path(data_dir) / STORAGE_FILE


def _load(data_dir: Path | None) -> dict:
    """Contenido del `storage.json`, o `{}` si falta o no sirve."""
    try:
        data = json.loads(_config_path(data_dir).read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write(data: dict, data_dir: Path | None) -> None:
    """Escribe el archivo entero, atomico (temporal + `os.replace`)."""
    path = _config_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".storage-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        # `os.replace` es atomico en el mismo volumen: nunca se lee a medias.
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def active_storage(data_dir: Path | None = None) -> str:
    """Almacenamiento activo: `local` o `google`.

    Falta el archivo, esta corrupto o trae un valor desconocido -> `local`: la
    biblioteca en este dispositivo es el default y el peor caso es no perder
    acceso a la musica.
    """
    data = _load(data_dir)
    if data.get("active") in KNOWN:
        return str(data["active"])
    return LOCAL


def set_active_storage(name: str, data_dir: Path | None = None) -> None:
    """Guarda el almacenamiento activo, atomico (temporal + `os.replace`)."""
    if name not in KNOWN:
        raise ValueError(f"almacenamiento desconocido: {name!r} (usar {KNOWN})")
    # El resto del archivo se conserva: la marca de Google conectado vive aca y
    # no se puede perder al pasar de google a local (o al reves).
    _write({**_load(data_dir), "active": name}, data_dir)


def google_connected(data_dir: Path | None = None) -> bool:
    """True si una cuenta de Google quedo conectada en este dispositivo.

    Solo Android la usa: ahi el access token es de memoria y lo reempuja el
    shell en cada arranque, asi que "conectado" no se puede deducir del disco.
    """
    return _load(data_dir).get(GOOGLE_CONNECTED) is True


def set_google_connected(connected: bool, data_dir: Path | None = None) -> None:
    """Pone (o saca) la marca de Google conectado, conservando el resto.

    Idempotente y sin escritura si no cambia nada: en Android se llama en cada
    refresco silencioso del token, cada ~50 minutos.
    """
    data = _load(data_dir)
    if connected:
        if data.get(GOOGLE_CONNECTED) is True:
            return
        data[GOOGLE_CONNECTED] = True
    else:
        if GOOGLE_CONNECTED not in data:
            return
        del data[GOOGLE_CONNECTED]
    _write(data, data_dir)
