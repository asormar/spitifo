"""Puerto `Storage`: TODO acceso a los archivos terminados de la biblioteca.

La biblioteca es del usuario y puede vivir en el disco local o en la nube
(docs/adr/0002-user-owned-storage.md, seccion 9). El resto del backend no sabe
donde esta: trabaja con CLAVES relativas a la raiz de la biblioteca, nunca con
rutas absolutas. Asi una clave significa lo mismo en cualquier dispositivo.

Modulo neutral: no importa starlette ni uvicorn, igual que config y runtime. El
adapter de disco (`.local.LocalStorage`) es el de referencia y conserva el
layout de carpetas de siempre (`<artista>/<artista> - <titulo>.<ext>`).
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Iterable, Iterator, Protocol

if TYPE_CHECKING:  # solo para las anotaciones: `playlists` importa de aca
    from ..playlists import PlaylistBook

log = logging.getLogger(__name__)

#: Largo maximo de una clave. Un nombre razonable nunca llega; esto solo acota
#: el trabajo de validacion y evita claves absurdas de la API.
MAX_KEY_LEN = 1024


@dataclass(frozen=True)
class StoredFile:
    """Un archivo terminado dentro de la biblioteca."""

    key: str  # relativa a la raiz, p.ej. "Artist/Artist - Title.mp3"
    size: int
    mtime: float
    etag: str | None = None  # revision del proveedor; None en disco local
    # Duracion real en segundos. Es un agregado al ADR: la UI de la biblioteca
    # muestra la duracion. `list()` la trae; `stat()` puede dejarla en None
    # (el adapter local la lee con mutagen y eso es caro para cada seek).
    duration: float | None = None
    # Etiquetas para que Escuchar agrupe por artista y album. Como la
    # duracion, las trae `list()`; vacias o None si el archivo no las tiene
    # (la UI cae a la carpeta y al nombre del archivo).
    title: str | None = None
    artist: str | None = None
    album: str | None = None


class InvalidKey(ValueError):
    """La clave no es valida (vacia, absoluta, con `..`, control chars...)."""


#: Caracteres que Windows no acepta en un nombre de archivo (los mismos que
#: limpia `models.safe_name`). El adapter de referencia es el disco, asi que una
#: clave tiene que poder ser un archivo real: si no, `put_file` fallaria recien
#: al escribir. El `/` se trata aparte porque es el separador.
_ILEGALES = set(':*?"<>|')


def validate_key(key: str) -> str:
    """Valida una clave y la devuelve tal cual si lo es.

    Reglas, compartidas por TODOS los adapters (esto reemplaza el chequeo
    `is_relative_to` que vivia en `/api/audio`): nada puede direccionar nada
    fuera de la raiz de la biblioteca.
    - str no vacio, de a lo sumo `MAX_KEY_LEN` caracteres.
    - separador `/` unicamente (una `\\` se rechaza).
    - relativa: sin `/` inicial y sin letra de unidad (`C:`).
    - sin segmentos vacios, `.` ni `..`.
    - sin NUL ni caracteres de control.
    - sin caracteres ilegales en un nombre de archivo (`:*?"<>|`).
    """
    if not isinstance(key, str) or not key:
        raise InvalidKey("la clave no puede estar vacia")
    if len(key) > MAX_KEY_LEN:
        raise InvalidKey("la clave es demasiado larga")
    if any(ord(c) < 32 or ord(c) == 127 for c in key):
        raise InvalidKey("la clave tiene caracteres de control")
    if "\\" in key:
        raise InvalidKey("la clave usa un separador invalido")
    if key.startswith("/"):
        raise InvalidKey("la clave no puede ser absoluta")
    if len(key) >= 2 and key[0].isalpha() and key[1] == ":":
        raise InvalidKey("la clave no puede traer letra de unidad")
    if _ILEGALES & set(key):
        raise InvalidKey("la clave tiene caracteres ilegales en un nombre")
    for parte in key.split("/"):
        if parte in ("", ".", ".."):
            raise InvalidKey("la clave tiene un segmento invalido")
    return key


class Storage(Protocol):
    """Acceso a los archivos terminados. `end` es INCLUSIVO, como los ranges HTTP."""

    def list(self) -> Iterable[StoredFile]: ...

    def stat(self, key: str) -> StoredFile: ...

    def open_range(self, key: str, start: int = 0,
                   end: int | None = None) -> Iterator[bytes]: ...

    def put_file(self, key: str, src: Path) -> StoredFile: ...

    def delete(self, key: str) -> None: ...

    # Playlists: puerto chico y SEPARADO del de archivos. Lo implementan los
    # dos adapters; la API lo usa desde un thread para no frenar el loop.
    def load_playlists(self) -> "PlaylistBook": ...

    def save_playlist(
            self, change: Callable[["PlaylistBook"], None]) -> "PlaylistBook": ...

    # Historial de escucha: archivos por dispositivo, igual que playlists.
    def append_listens(self, events: list[dict]) -> int: ...

    def load_listens_summary(self) -> dict: ...

    def describe(self) -> str:
        """Etiqueta humana de donde vive la biblioteca (la muestra la UI)."""
        ...


def _library_root() -> Path:
    """Raiz de la biblioteca local. Mismo default y variable que ya usa la app."""
    return Path(os.getenv("SPITIFO_LIBRARY",
                          Path(__file__).resolve().parents[3] / "library"))


#: Adapter activo del proceso. Se arma la primera vez que hace falta y los tests
#: lo pisan con `set_storage`.
_storage: Storage | None = None


def _build_google() -> Storage:
    """Arma el adapter de Drive o cae a local si falta la configuracion.

    La eleccion puede venir de `storage.json` (la pantalla de conexion), sin
    variables de entorno de por medio: si el cliente OAuth no esta configurado,
    la app tiene que arrancar igual y quedarse con la biblioteca local.

    En Android no hay configuracion OAuth que pueda faltar —el token lo trae el
    host—, asi que ahi no se cae a local: el adapter de Drive se arma siempre.
    """
    from ..cloud.android import is_android
    from ..cloud.drive import drive_storage_from_env
    from ..cloud.oauth import OAuthNotConfigured
    if is_android():
        return drive_storage_from_env()
    try:
        return drive_storage_from_env()
    except OAuthNotConfigured as exc:
        log.warning("Drive no esta configurado (%s): la biblioteca queda local",
                    exc)
        from .local import LocalStorage
        return LocalStorage(_library_root())


def _setting_backend() -> str:
    """Proveedor elegido desde la UI (`storage.json`), `local` por defecto."""
    from ..cloud.settings import active_storage
    return active_storage()


def get_storage() -> Storage:
    """Adapter activo.

    `SPITIFO_STORAGE` manda cuando esta seteada (comportamiento de siempre,
    incluido el error por valor desconocido). Si no, decide el ajuste de la UI:
    `google` arma Drive y, si falta la configuracion OAuth, avisa y usa el
    disco. El import del conector es perezoso: `storage` tiene que poder
    importarse aunque el paquete de nube no este disponible.
    """
    global _storage
    if _storage is None:
        backend = os.getenv("SPITIFO_STORAGE", "").strip()
        if backend == "google":
            from ..cloud.drive import drive_storage_from_env
            _storage = drive_storage_from_env()
        elif backend:
            raise ValueError(
                f"SPITIFO_STORAGE desconocido: {backend!r} (usar 'google')")
        elif _setting_backend() == "google":
            _storage = _build_google()
        else:
            from .local import LocalStorage
            _storage = LocalStorage(_library_root())
    return _storage


def set_storage(s: Storage | None) -> None:
    """Instala un adapter (tests) o vuelve al de siempre con `None`."""
    global _storage
    _storage = s


def reset_storage() -> None:
    """Olvida el adapter activo: el proximo `get_storage` lo arma de nuevo.

    Es el alias legible de `set_storage(None)` que usa la API despues de
    cambiar el almacenamiento activo.
    """
    set_storage(None)

