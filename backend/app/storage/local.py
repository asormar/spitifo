"""Adapter de la biblioteca en el disco local. Es el de referencia.

Conserva el layout de carpetas de siempre: `<artista>/<artista> - <titulo>.<ext>`
relativo a `root`, que es exactamente lo que venia haciendo el downloader.
"""
from __future__ import annotations

import logging
import os
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Callable, Iterable, Iterator

from ..config import AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS
from ..playlists import PlaylistBook, PlaylistFormatError
from . import InvalidKey, StoredFile, validate_key

log = logging.getLogger(__name__)

#: Tamano de cada lectura de `open_range`. 64 KiB es lo que usa el downloader
#: para bajar y lo que acostumbra el streaming.
CHUNK = 64 * 1024

#: Carpeta oculta con el estado propio del dispositivo (playlists). `list()` ya
#: salta los dot-dirs, asi que nunca aparece como biblioteca.
STATE_DIR = ".spitifo"
PLAYLISTS_FILE = "playlists.json"


def _tag(audio, name: str) -> str | None:
    """Primer valor de una etiqueta de mutagen (en modo `easy`), o None."""
    try:
        value = audio.get(name)
    except Exception:
        return None
    if not value:
        return None
    text = str(value[0]).strip()
    return text or None


def _media_info(p: Path) -> tuple[float | None, str | None, str | None, str | None]:
    """Duracion real en segundos y titulo, artista y album, en UNA lectura.

    `list()` ya abria cada archivo con mutagen para la duracion; las etiquetas
    salen del mismo objeto, asi que no suman otra lectura del disco. `easy`
    unifica los nombres (ID3, MP4 y Vorbis responden a "artist"). Lo que no se
    pueda leer queda en None.
    """
    try:
        from mutagen import File as MFile
        f = MFile(p, easy=True)
    except Exception:
        return None, None, None, None
    if f is None:
        return None, None, None, None
    duration = None
    try:
        if f.info is not None:
            duration = round(float(f.info.length), 1)
    except Exception:
        pass
    return duration, _tag(f, "title"), _tag(f, "artist"), _tag(f, "album")


class LocalStorage:
    """`Storage` sobre una carpeta del disco (la biblioteca publica en Android)."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        # Lectura-modificacion-escritura de playlists: dos requests a la vez no
        # pueden perder el cambio de la otra.
        self._playlists_lock = threading.Lock()

    # ------------------------------------------------------------- internos
    def _path(self, key: str) -> Path:
        """Valida la clave y devuelve la ruta local.

        Ademas de `validate_key` (que ya prohibe `..` y rutas absolutas) se
        resuelve la ruta y se exige que siga adentro de la raiz: un symlink
        dentro de la biblioteca podria apuntar afuera.
        """
        validate_key(key)
        p = self.root / key
        if not p.resolve().is_relative_to(self.root.resolve()):
            raise InvalidKey(f"la clave sale de la biblioteca: {key}")
        return p

    def _stored(self, p: Path, key: str, *, duration: bool = False) -> StoredFile:
        # La duracion y las etiquetas obligan a parsear el archivo con mutagen:
        # solo las pide `list()`, que es lo que muestra la UI. `stat()` corre en cada request
        # de `/api/audio` (cada seek) y tiene que ser un stat y nada mas.
        st = p.stat()
        if not duration:
            return StoredFile(key=key, size=st.st_size, mtime=st.st_mtime)
        dur, title, artist, album = _media_info(p)
        return StoredFile(key=key, size=st.st_size, mtime=st.st_mtime,
                          duration=dur, title=title, artist=artist, album=album)

    # --------------------------------------------------------------- puerto
    def list(self) -> Iterable[StoredFile]:
        """Media de la biblioteca, saltando ocultos y symlinks que escapan.

        Incluye video y las miniaturas `.jpg`: `library_scan` decide despues
        cuales son temas y cuales sidecars.
        """
        exts = {e.lower() for e in (*AUDIO_EXTS, *VIDEO_EXTS, *IMAGE_EXTS)}
        root = self.root.resolve()
        for p in sorted(self.root.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(self.root)
            # nada bajo un dot-dir ni un dot-file (.part, .tmp, .oculto...)
            if any(part.startswith(".") for part in rel.parts):
                continue
            if p.suffix.lower() not in exts:
                continue
            if not p.resolve().is_relative_to(root):
                continue
            key = rel.as_posix()
            # Un nombre que la clave no admite (en Linux/Android un archivo
            # puede llevar `?` o `:`) no se lista: se veria en la biblioteca y
            # despues daria 404 al reproducirlo.
            try:
                validate_key(key)
            except InvalidKey:
                continue
            yield self._stored(p, key, duration=True)

    def stat(self, key: str) -> StoredFile:
        p = self._path(key)
        if not p.is_file():
            raise FileNotFoundError(key)
        return self._stored(p, key)

    def open_range(self, key: str, start: int = 0,
                   end: int | None = None) -> Iterator[bytes]:
        """Bytes de `key` en `[start, end]`. `end=None` = hasta el final.

        `end` es INCLUSIVO (igual que un range HTTP) y se recorta al tamano del
        archivo. Un rango vacio (start fuera del archivo o end < start) no
        devuelve nada. El archivo se cierra al agotar el iterador o al cerrarlo.
        """
        p = self._path(key)
        if not p.is_file():
            raise FileNotFoundError(key)
        size = p.stat().st_size
        start = max(0, start)
        if end is not None and end >= size:
            end = size - 1
        if end is None:
            n = size - start
        else:
            n = end - start + 1
        return self._read(p, start, max(0, n))

    def _read(self, p: Path, start: int, n: int) -> Iterator[bytes]:
        if n <= 0:
            return
        with open(p, "rb") as f:
            f.seek(start)
            restante = n
            while restante > 0:
                chunk = f.read(min(CHUNK, restante))
                if not chunk:
                    break
                restante -= len(chunk)
                yield chunk

    def put_file(self, key: str, src: Path) -> StoredFile:
        """Mueve `src` a `key`, creando carpetas y sobreescribiendo lo que hubiera."""
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        # shutil.move y no os.replace: sobreescribe el destino y ademas cruza
        # filesystems (EXDEV) si el temporal esta en otra particion.
        shutil.move(str(src), str(p))
        return self._stored(p, key)

    def delete(self, key: str) -> None:
        p = self._path(key)
        if not p.is_file():
            raise FileNotFoundError(key)
        p.unlink()

    def describe(self) -> str:
        return str(self.root)

    # ------------------------------------------------------------- playlists
    def _playlists_path(self) -> Path:
        return self.root / STATE_DIR / PLAYLISTS_FILE

    def _read_own_playlists(self) -> tuple[PlaylistBook, bool]:
        """`(libro, ilegible)` desde `.spitifo/playlists.json`.

        Un archivo ausente es un libro vacio (normal). Un archivo que no se
        puede leer o parsear tambien se devuelve vacio, pero marcado ilegible:
        guardar encima perderia las playlists del usuario.
        """
        path = self._playlists_path()
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            return PlaylistBook(), False
        except OSError as exc:
            log.warning("playlists ilegibles %s: %s", path, exc)
            return PlaylistBook(), True
        try:
            return PlaylistBook.from_bytes(data), False
        except PlaylistFormatError as exc:
            log.warning("playlists ilegibles %s: %s", path, exc)
            return PlaylistBook(), True

    def load_playlists(self) -> PlaylistBook:
        with self._playlists_lock:
            return self._read_own_playlists()[0]

    def save_playlist(
            self, change: Callable[[PlaylistBook], None]) -> PlaylistBook:
        """Aplica `change` al libro propio y lo persiste de forma atomica.

        Si el archivo existe pero no se pudo leer, NO se pisa: se levanta
        `RuntimeError` (misma regla que el indice propio en la nube).
        """
        with self._playlists_lock:
            book, unreadable = self._read_own_playlists()
            if unreadable:
                raise RuntimeError(
                    f"no se pudieron leer {PLAYLISTS_FILE}: no se sobrescribe")
            change(book)
            self._write_playlists(book)
            return book

    def _write_playlists(self, book: PlaylistBook) -> None:
        """Temporal en la misma carpeta + `os.replace`: nunca queda a medias."""
        path = self._playlists_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".playlists-",
                                   suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(book.to_bytes())
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
