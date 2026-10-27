"""Base COMUN de un adapter de `Storage` sobre una nube (ADR 0002, secciones 4 a 8).

Un proveedor concreto (hoy solo Google Drive) hereda de `CloudStorage` y
completa los hooks de la seccion final: la biblioteca vive en la carpeta visible
de la app, con las carpetas del usuario espejadas debajo. El indice NO esta en un
solo `index.json`: no todos los proveedores tienen escritura condicional, asi que
cada dispositivo escribe SOLO su `index-<device_id>.json` (un unico escritor por
archivo, sin conflictos) y la biblioteca es el merge de todos esos indices
(`LibraryIndex.merge`: gana el `updated_at` mas nuevo; los tombstones evitan
resucitar un borrado).

Toda salida a la red va por el `httpx.Client` inyectado, asi los tests usan
`httpx.MockTransport` y nunca tocan internet. Modulo neutral: no importa
starlette ni uvicorn ni el SDK de ningun proveedor.
"""
from __future__ import annotations

import logging
import mimetypes
import os
import secrets
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, ContextManager, Iterator

import httpx

from ..artistinfo import ARTISTINFO_PREFIX, ArtistInfoStorageMixin
from ..config import AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS
from ..discover import DISCOVER_PREFIX, DiscoverStorageMixin
from ..listens import ListensStorageMixin
from ..playlists import PlaylistBook, PlaylistFormatError
from ..runtime import MEDIA_MIME_TYPES
from ..storage import StoredFile, validate_key
from .cache import AudioCache
from .library_index import IndexEntry, IndexFormatError, LibraryIndex
from .tokens import TokenSource

log = logging.getLogger(__name__)

#: Carpeta visible que crea la app en el proveedor (ADR 0002, seccion 1).
FOLDER_NAME = "Spitifo"

#: Prefijo de los archivos chicos por dispositivo. Uno para el indice y otro
#: para las playlists; cada dispositivo escribe SOLO el suyo y la vista es el
#: merge de todos.
INDEX_PREFIX = "index-"
PLAYLIST_PREFIX = "playlists-"

#: Tamano de cada lectura de `open_range`, igual que el adapter local.
CHUNK = 64 * 1024

#: Cuanto vale el indice en memoria antes de releerlo de la nube.
INDEX_TTL = 30.0
#: Cuanto vale la cuota en memoria: la pantalla de conexion la pide al abrirse
#: y mientras espera el sign-in, no hace falta preguntarle a la nube cada vez.
QUOTA_TTL = 60.0
#: Status que se reintentan solos, con backoff.
RETRY_STATUS = frozenset({429, 500, 502, 503, 504})
MAX_RETRIES = 3


class QuotaExceeded(RuntimeError):
    """La cuenta de la nube esta llena: la UI avisa y la pista se queda local."""


# ------------------------------------------------------------------- ayudantes
def _parent(key: str) -> str:
    return key.rsplit("/", 1)[0] if "/" in key else ""


def _ext_of(key: str) -> str:
    name = key.rsplit("/", 1)[-1]
    if "." not in name:
        return ""
    return name.rsplit(".", 1)[-1].upper()


def _mime_of(key: str) -> str:
    """MIME de la clave. Cae a la tabla de media si `mimetypes` no lo sabe.

    El runtime ya registra los tipos al arrancar; esto es el respaldo por si el
    adapter se usa sin llamar a `configure_runtime` (los tests, por ejemplo).
    """
    mime = mimetypes.guess_type(key)[0]
    if mime:
        return mime
    return MEDIA_MIME_TYPES.get(Path(key).suffix.lower(),
                                "application/octet-stream")


def _first(audio, name: str) -> str:
    try:
        value = audio.get(name)
    except Exception:
        return ""
    if not value:
        return ""
    return str(value[0])


def _read_tags(path: Path) -> tuple[str, str, str, float | None]:
    """Titulo, artista, album y duracion del archivo LOCAL antes de subirlo.

    Se leen una sola vez y viajan en el indice: los demas dispositivos muestran
    la biblioteca sin bajar los archivos.
    """
    title = artist = album = ""
    duration: float | None = None
    try:
        from mutagen import File as MFile
        audio = MFile(str(path), easy=True)
        if audio is not None:
            title = _first(audio, "title")
            artist = _first(audio, "artist")
            album = _first(audio, "album")
            info = getattr(audio, "info", None)
            if info is not None:
                duration = round(float(info.length), 1)
    except Exception:
        pass
    return title, artist, album, duration


def _read_path(path: Path, start: int, n: int) -> Iterator[bytes]:
    """Bytes de un archivo local ya cacheado, en `[start, start+n)`."""
    if n <= 0:
        return
    with open(path, "rb") as f:
        f.seek(start)
        restante = n
        while restante > 0:
            chunk = f.read(min(CHUNK, restante))
            if not chunk:
                break
            restante -= len(chunk)
            yield chunk


class _RemoteBody:
    """Cuerpo de una descarga ya abierta: exactamente `n` bytes y despues cierra.

    Es una clase y no un generador porque un generador que nunca arranco no
    corre su `finally` al cerrarse: si el cliente corta antes del primer byte,
    la conexion quedaria tomada del pool.
    """

    def __init__(self, stream, resp: httpx.Response, n: int) -> None:
        self._stream = stream
        self._chunks = resp.iter_bytes()
        self._left = n
        self._closed = False

    def __iter__(self) -> _RemoteBody:
        return self

    def __next__(self) -> bytes:
        while self._left > 0 and not self._closed:
            try:
                chunk = next(self._chunks)
            except StopIteration:
                break
            except BaseException:
                self.close()
                raise
            if not chunk:
                continue
            chunk = chunk[: self._left]
            self._left -= len(chunk)
            return chunk
        self.close()
        raise StopIteration

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._stream.__exit__(None, None, None)

    def __del__(self) -> None:
        self.close()


def default_device_id(data_dir: Path) -> str:
    """Id aleatorio del dispositivo, guardado una vez en `data_dir/device_id`.

    Es la clave de `index-<device>.json`: cada dispositivo escribe el suyo y
    nadie mas, asi que no hay escrituras concurrentes que resolver.
    """
    data_dir = Path(data_dir)
    path = data_dir / "device_id"
    try:
        value = path.read_text("utf-8").strip()
        if value:
            return value
    except OSError:
        pass
    value = secrets.token_hex(8)
    data_dir.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=data_dir, prefix=".device-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(value)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return value


def upload_ranges(total: int, chunk: int) -> list[tuple[int, int]]:
    """Rangos INCLUSIVOS `(start, end)` que cubren `total` bytes de a `chunk`."""
    if total <= 0:
        return []
    if chunk <= 0:
        raise ValueError("chunk tiene que ser > 0")
    ranges: list[tuple[int, int]] = []
    start = 0
    while start < total:
        end = min(start + chunk, total) - 1
        ranges.append((start, end))
        start = end + 1
    return ranges


# ------------------------------------------------------------------- adapter
class CloudStorage(ListensStorageMixin, ArtistInfoStorageMixin,
                   DiscoverStorageMixin):
    """`Storage` sobre una nube. El proveedor concreto implementa los hooks.

    Esta clase tiene todo lo que NO depende del proveedor: reintentos, el indice
    por dispositivo con su merge, la cache, los rangos y la cuota. Los hooks de
    la seccion final son lo unico que cambia entre proveedores.
    """

    def __init__(self, tokens: TokenSource, client: httpx.Client, device_id: str,
                 cache: AudioCache | None = None, folder_name: str = FOLDER_NAME,
                 clock: Callable[[], float] = time.time,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self.tokens = tokens
        self.client = client
        self.device_id = device_id
        self.cache = cache
        self.folder_name = folder_name
        self._clock = clock
        self.sleep = sleep
        self._lock = threading.RLock()
        # Ids de carpeta del proveedor ya resueltos, por ruta relativa ("" es la
        # raiz de la biblioteca): la logica de carpetas vive en cada adapter.
        self._folders: dict[str, str] = {}
        self._index: LibraryIndex | None = None
        self._index_at = float("-inf")
        self._own = LibraryIndex()
        self._own_index_id: str | None = None
        # True si el indice PROPIO existe pero no se pudo leer: escribirlo asi
        # lo pisaria con una copia casi vacia y se perderia la biblioteca.
        self._own_unreadable = False
        # Mismo esquema para las playlists: libro mergeado en memoria, libro
        # propio, id del archivo propio y si ese archivo estaba ilegible.
        self._playlists: PlaylistBook | None = None
        self._playlists_at = float("-inf")
        self._own_playlists = PlaylistBook()
        self._own_playlists_id: str | None = None
        self._own_playlists_unreadable = False
        self._quota_cache: dict | None = None
        self._quota_cache_at = float("-inf")
        # Prefetch del proximo tema: el par (remote_id, revision) que YA se esta
        # bajando, para que dos avisos seguidos de la UI no lo bajen dos veces.
        self._prefetch_lock = threading.Lock()
        self._prefetching: set[tuple[str, str]] = set()

    # --------------------------------------------------------- HTTP con reintentos
    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.tokens.access_token()}"}

    def _is_retryable(self, resp: httpx.Response) -> bool:
        """Default: los status que se reintentan solos. El proveedor puede sumar."""
        return resp.status_code in RETRY_STATUS

    def _delay(self, resp: httpx.Response, attempt: int) -> float:
        retry_after = resp.headers.get("Retry-After")
        if retry_after:
            try:
                return max(0.0, float(retry_after))
            except ValueError:
                pass
        return float(min(2 ** attempt, 8))

    def _translate_error(self, resp: httpx.Response) -> None:
        """Traduce un error del proveedor a una excepcion propia. Default: nada.

        Se llama antes de `raise_for_status`: aca el proveedor levanta lo que la
        UI tiene que distinguir (p. ej. la cuenta llena).
        """

    def _request(self, method: str, url: str, expect: tuple[int, ...] = (),
                 auth: bool = True, **kw) -> httpx.Response:
        """Request con bearer, un reintento ante 401 y backoff ante 429/5xx.

        Un 401 pide un token nuevo al origen y reintenta UNA vez (ADR 0002,
        seccion 8). Los 429 y los 5xx se reintentan hasta `MAX_RETRIES`
        respetando `Retry-After`. `expect` lista status no-2xx que son respuesta
        valida (p. ej. el `308` de una sesion resumable a medio subir): no cortan.
        Con `auth=False` NO se manda el bearer: es para las URLs ya
        pre-autenticadas que algunos proveedores devuelven para descargar o para
        subir por partes, y que rechazan un Authorization de mas.
        """
        headers = dict(kw.pop("headers", None) or {})
        if auth:
            headers.update(self._auth())
        attempt = 0
        retried_auth = False
        while True:
            resp = self.client.request(method, url, headers=headers, **kw)
            if auth and resp.status_code == 401 and not retried_auth:
                self.tokens.invalidate()
                headers.update(self._auth())
                retried_auth = True
                continue
            if self._is_retryable(resp) and attempt < MAX_RETRIES:
                self.sleep(self._delay(resp, attempt))
                attempt += 1
                continue
            self._translate_error(resp)
            if resp.status_code not in expect:
                resp.raise_for_status()
            return resp

    @contextmanager
    def _stream(self, method: str, url: str, auth: bool = True,
                **kw) -> Iterator[httpx.Response]:
        """Como `_request` pero en streaming: el 401 se reintenta antes del body.

        `auth=False` vale por lo mismo que en `_request`: una URL
        pre-autenticada no puede recibir el bearer.
        """
        headers = dict(kw.pop("headers", None) or {})
        if auth:
            headers.update(self._auth())
        attempt = 0
        retried_auth = False
        while True:
            request = self.client.build_request(method, url, headers=headers,
                                                **kw)
            resp = self.client.send(request, stream=True)
            if auth and resp.status_code == 401 and not retried_auth:
                resp.close()
                self.tokens.invalidate()
                headers.update(self._auth())
                retried_auth = True
                continue
            if self._is_retryable(resp) and attempt < MAX_RETRIES:
                delay = self._delay(resp, attempt)
                resp.close()
                self.sleep(delay)
                attempt += 1
                continue
            break
        try:
            self._translate_error(resp)
            resp.raise_for_status()
            yield resp
        finally:
            resp.close()

    # --------------------------------------------------------------------- indice
    def _own_name(self) -> str:
        return f"index-{self.device_id}.json"

    def _load_index(self, force: bool = False) -> LibraryIndex:
        """Merge de todos los `index-*.json` de la biblioteca, con TTL en memoria.

        Un indice que no parsea se saltea y se loguea: no puede tumbar la
        biblioteca entera. Se recuerda, ademas, el id del indice PROPIO.
        """
        with self._lock:
            if (not force and self._index is not None
                    and (self._clock() - self._index_at) < INDEX_TTL):
                return self._index
            merged = LibraryIndex()
            own = LibraryIndex()
            own_id: str | None = None
            own_unreadable = False
            for remote_id, name in self._list_small_files(INDEX_PREFIX):
                if not name.startswith(INDEX_PREFIX):
                    continue
                try:
                    parsed = LibraryIndex.from_bytes(self._read_file(remote_id))
                except (httpx.HTTPError, IndexFormatError) as exc:
                    log.warning("indice ilegible %s: %s", name, exc)
                    if name == self._own_name():
                        own_id = remote_id
                        own_unreadable = True
                    continue
                merged = merged.merge(parsed)
                if name == self._own_name():
                    own_id = remote_id
                    own = parsed
            self._index = merged
            self._index_at = self._clock()
            self._own_index_id = own_id
            self._own = own
            self._own_unreadable = own_unreadable
            return merged

    def _write_own(self, change: Callable[[LibraryIndex], None]) -> None:
        """Aplica `change` al indice PROPIO y lo sube a la nube.

        Un solo escritor por archivo: no hace falta escritura condicional.
        Despues mergea el resultado en la vista en memoria.
        """
        with self._lock:
            self._load_index()
            if self._own_unreadable:
                # Un corte de red pasajero: se reintenta una vez antes de rendirse.
                self._load_index(force=True)
            if self._own_unreadable:
                raise RuntimeError(
                    f"no se pudo leer {self._own_name()}: no se sobrescribe")
            own = LibraryIndex(entries=dict(self._own.entries))
            change(own)
            body = own.to_bytes()
            if self._own_index_id:
                self._replace_file(self._own_index_id, body)
            else:
                created = self._create_file(self._own_name(), body)
                self._own_index_id = str(created["id"])
            self._own = own
            # El indice recien escrito es el mas fresco para SUS claves: en un
            # empate de `updated_at` (el reloj de Windows tiene resolucion
            # gruesa) el merge comun le daria la razon al valor viejo que ya
            # estaba en memoria.
            self._index = own.merge(self._index or LibraryIndex())
            self._index_at = self._clock()

    def _entry(self, key: str) -> IndexEntry | None:
        """Entrada viva de la clave. Recarga UNA vez si no esta en memoria.

        Ignora el TTL si la clave ya se conoce: `/api/audio` llama esto en
        cada seek y no puede esperar a releer todos los indices de la nube.
        `list()` es quien mantiene la vista fresca.
        """
        with self._lock:
            index = self._index
        if index is None:
            index = self._load_index()
        entry = index.entries.get(key)
        if entry is None:
            index = self._load_index(force=True)
            entry = index.entries.get(key)
        if entry is None or entry.deleted:
            return None
        return entry

    # ---------------------------------------------------------------- playlists
    def _own_playlists_name(self) -> str:
        return f"{PLAYLIST_PREFIX}{self.device_id}.json"

    def load_playlists(self, force: bool = False) -> PlaylistBook:
        """Merge de todos los `playlists-*.json`, con el mismo TTL del indice.

        Un archivo que no parsea se saltea y se loguea, y se recuerda si era el
        PROPIO: escribir encima perderia las playlists del usuario.
        """
        with self._lock:
            if (not force and self._playlists is not None
                    and (self._clock() - self._playlists_at) < INDEX_TTL):
                return self._playlists
            merged = PlaylistBook()
            own = PlaylistBook()
            own_id: str | None = None
            own_unreadable = False
            for remote_id, name in self._list_small_files(PLAYLIST_PREFIX):
                if not name.startswith(PLAYLIST_PREFIX):
                    continue
                try:
                    parsed = PlaylistBook.from_bytes(self._read_file(remote_id))
                except (httpx.HTTPError, PlaylistFormatError) as exc:
                    log.warning("playlists ilegibles %s: %s", name, exc)
                    if name == self._own_playlists_name():
                        own_id = remote_id
                        own_unreadable = True
                    continue
                merged = merged.merge(parsed)
                if name == self._own_playlists_name():
                    own_id = remote_id
                    own = parsed
            self._playlists = merged
            self._playlists_at = self._clock()
            self._own_playlists_id = own_id
            self._own_playlists = own
            self._own_playlists_unreadable = own_unreadable
            return merged

    def save_playlist(
            self, change: Callable[[PlaylistBook], None]) -> PlaylistBook:
        """Aplica `change` al archivo PROPIO y lo sube (crear o reemplazar).

        Un solo escritor por archivo, como el indice: no hace falta escritura
        condicional. Despues mergea el resultado en la vista en memoria.
        """
        with self._lock:
            self.load_playlists()
            if self._own_playlists_unreadable:
                # Un corte de red pasajero: se reintenta una vez antes de rendirse.
                self.load_playlists(force=True)
            if self._own_playlists_unreadable:
                raise RuntimeError(
                    f"no se pudieron leer {self._own_playlists_name()}: "
                    "no se sobrescribe")
            own = PlaylistBook(playlists=dict(self._own_playlists.playlists))
            change(own)
            body = own.to_bytes()
            if self._own_playlists_id:
                self._replace_file(self._own_playlists_id, body)
            else:
                created = self._create_file(self._own_playlists_name(), body)
                self._own_playlists_id = str(created["id"])
            self._own_playlists = own
            # Igual que con el indice: lo recien escrito gana los empates de
            # `updated_at` contra la copia que ya estaba en memoria.
            self._playlists = own.merge(self._playlists or PlaylistBook())
            self._playlists_at = self._clock()
            return self._playlists

    # ------------------------------------------------------------------ listens
    def _listens_device(self) -> str:
        return self.device_id

    def _listens_list(self) -> list[tuple[str, str]]:
        """`(remote_id, name)` de los mensuales y agregados de escucha."""
        return (self._list_small_files("listens-")
                + self._list_small_files("listenagg-"))

    def _listens_read(self, ref: str) -> bytes:
        return self._read_file(ref)

    def _listens_write(self, name: str, data: bytes,
                       ref: str | None = None) -> str:
        if ref:
            self._replace_file(ref, data)
            return ref
        created = self._create_file(name, data)
        return str(created["id"])

    def _listens_delete(self, ref: str) -> None:
        self._trash(ref)

    # --------------------------------------------------------------- artistinfo
    def _artistinfo_device(self) -> str:
        return self.device_id

    def _artistinfo_list(self) -> list[tuple[str, str]]:
        """`(remote_id, name)` de las fichas de todos los dispositivos."""
        return self._list_small_files(ARTISTINFO_PREFIX)

    def _artistinfo_read(self, ref: str) -> bytes:
        return self._read_file(ref)

    def _artistinfo_write(self, name: str, data: bytes,
                          ref: str | None = None) -> str:
        return self._write_small(name, data, ref)

    # ----------------------------------------------------------------- discover
    def _discover_device(self) -> str:
        return self.device_id

    def _discover_list(self) -> list[tuple[str, str]]:
        """`(remote_id, name)` de los descartes de todos los dispositivos."""
        return self._list_small_files(DISCOVER_PREFIX)

    def _discover_read(self, ref: str) -> bytes:
        return self._read_file(ref)

    def _discover_write(self, name: str, data: bytes,
                        ref: str | None = None) -> str:
        return self._write_small(name, data, ref)

    def _write_small(self, name: str, data: bytes,
                     ref: str | None = None) -> str:
        """Crea o reemplaza un archivo chico y devuelve su ref."""
        if ref:
            self._replace_file(ref, data)
            return ref
        created = self._create_file(name, data)
        return str(created["id"])

    # ---------------------------------------------------------------------- puerto
    def list(self) -> list[StoredFile]:
        exts = {e.lower() for e in (*AUDIO_EXTS, *VIDEO_EXTS, *IMAGE_EXTS)}
        out: list[StoredFile] = []
        for entry in self._load_index().live():
            key = entry.key
            if any(part.startswith(".") for part in key.split("/")):
                continue
            if Path(key).suffix.lower() not in exts:
                continue
            out.append(StoredFile(key=key, size=entry.size,
                                  mtime=entry.updated_at,
                                  etag=entry.revision or None,
                                  duration=entry.duration,
                                  title=entry.title or None,
                                  artist=entry.artist or None,
                                  album=entry.album or None))
        out.sort(key=lambda f: f.key)
        return out

    def stat(self, key: str) -> StoredFile:
        validate_key(key)
        entry = self._entry(key)
        if entry is None:
            raise FileNotFoundError(key)
        return StoredFile(key=key, size=entry.size, mtime=entry.updated_at,
                          etag=entry.revision or None, duration=entry.duration)

    def open_range(self, key: str, start: int = 0,
                   end: int | None = None) -> Iterator[bytes]:
        """Bytes de `key` en `[start, end]`. `end` INCLUSIVO, como HTTP.

        Valida y confirma que existe ANTES de devolver el iterador (igual que el
        adapter local): el 404 no puede aparecer recien al leer el primer chunk.
        """
        validate_key(key)
        entry = self._entry(key)
        if entry is None:
            raise FileNotFoundError(key)
        size = entry.size
        start = max(0, start)
        if end is not None and end >= size:
            end = size - 1
        n = size - start if end is None else end - start + 1
        n = max(0, n)
        if n > 0 and self.cache is not None and entry.remote_id:
            cached = self.cache.get(entry.remote_id, entry.revision)
            if cached is not None:
                return _read_path(cached, start, n)
        return self._open_stream(entry, start, n)

    def prefetch(self, key: str) -> bool:
        """Baja `key` ENTERO a la cache, SIN pinnearlo: adelanto del proximo tema.

        La UI lo pide al empezar un tema para que el siguiente arranque de la
        cache en vez de la red (auto-advance). El archivo queda unpinned, asi que
        el LRU puede sacarlo: es un adelanto, no algo que el usuario pidio.

        Devuelve False si no hay cache, la clave no esta en el indice o la
        entrada no tiene `remote_id`; True si ya estaba en cache o si termino de
        bajarlo. Un prefetch del mismo `(remote_id, revision)` ya en curso no
        arranca otro. Las excepciones salen al llamador: la ruta las loguea.
        """
        validate_key(key)
        cache = self.cache
        if cache is None:
            return False
        entry = self._entry(key)
        if entry is None or not entry.remote_id:
            return False
        remote_id, revision = entry.remote_id, entry.revision
        if cache.get(remote_id, revision) is not None:
            return True
        token = (remote_id, revision)
        with self._prefetch_lock:
            if token in self._prefetching:
                return False
            self._prefetching.add(token)
        try:
            self._download_to_cache(entry)
        finally:
            with self._prefetch_lock:
                self._prefetching.discard(token)
        return True

    def _download_to_cache(self, entry: IndexEntry) -> None:
        """Streaming a un temporal y despues `cache.put` (unpinned).

        El temporal vive en la misma raiz de la cache (mismo volumen), asi que
        `put` es una copia local. Se borra SIEMPRE, haya salido bien o mal.
        """
        cache = self.cache
        assert cache is not None  # `prefetch` ya lo chequeo
        fd, tmp = tempfile.mkstemp(dir=cache.root, prefix=".prefetch-",
                                   suffix=".tmp")
        tmp_path = Path(tmp)
        try:
            # El cuerpo se escribe a disco a medida que llega: nada de juntar el
            # archivo entero en memoria (eso es `_read_file`, solo para el indice).
            with os.fdopen(fd, "wb") as out:
                with self._stream_whole(entry) as resp:
                    for chunk in resp.iter_bytes():
                        out.write(chunk)
            cache.put(entry.remote_id, entry.revision, tmp_path,
                      _ext_of(entry.key))
        finally:
            try:
                tmp_path.unlink()
            except OSError:
                pass

    def put_file(self, key: str, src: Path) -> StoredFile:
        """Sube `src` a `key` y lo BORRA (el puerto MUEVE)."""
        validate_key(key)
        src = Path(src)
        size = src.stat().st_size
        ext = _ext_of(key)
        media_type = _mime_of(key)
        # Un jpg no tiene tags que leer (y mutagen no lo parsea): se sube con la
        # metadata vacia. El video si se intenta; si mutagen falla, queda vacia.
        if Path(key).suffix.lower() in IMAGE_EXTS:
            title = artist = album = ""
            duration: float | None = None
        else:
            title, artist, album, duration = _read_tags(src)

        existing = self._entry(key)
        existing_id = existing.remote_id if existing is not None else None
        remote_id, revision = self._upload(key, src, size, media_type,
                                           existing_id)

        entry = IndexEntry(key=key, remote_id=remote_id, revision=revision,
                           title=title, artist=artist, album=album,
                           duration=duration, size=size, format=ext,
                           updated_at=self._clock())
        self._write_own(lambda index: index.upsert(entry))

        if self.cache is not None:
            if existing is not None and existing.revision != revision:
                # La revision vieja ya no es lo que el usuario tiene: puede salir.
                self.cache.unpin(existing.remote_id, existing.revision)
            # El usuario lo bajo a proposito: se guarda y se pinea antes de
            # soltar el temporal (ADR 0002, seccion 7).
            self.cache.put(remote_id, revision, src, ext)
            self.cache.pin(remote_id, revision)
        src.unlink()
        return StoredFile(key=key, size=size, mtime=entry.updated_at,
                          etag=revision, duration=duration)

    def delete(self, key: str) -> None:
        validate_key(key)
        entry = self._entry(key)
        if entry is None:
            raise FileNotFoundError(key)
        self._trash(entry.remote_id)
        self._write_own(lambda index: index.remove(key, self._clock()))
        if self.cache is not None:
            self.cache.unpin(entry.remote_id, entry.revision)

    def quota(self) -> dict:
        """Espacio de la cuenta: `{limit, usage, app}` en bytes.

        `limit` es None en cuentas sin tope. `usage` es todo lo de la cuenta
        (el proveedor suele compartirlo entre sus servicios); `app` es lo que
        ocupa la biblioteca de Spitifo, sumado desde el indice sin otra llamada.
        """
        with self._lock:
            if self._quota_cache is not None and (
                    self._clock() - self._quota_cache_at) < QUOTA_TTL:
                return dict(self._quota_cache)
        limit, usage = self._quota_remote()
        app = sum(f.size for f in self.list())
        quota = {"limit": limit, "usage": usage, "app": app}
        with self._lock:
            self._quota_cache = quota
            self._quota_cache_at = self._clock()
        return dict(quota)

    # -------------------------------------------------------------------- hooks
    # Lo unico que cambia entre proveedores. Son chicos a proposito: el indice,
    # la cache, los reintentos y los rangos viven arriba, en esta misma clase.

    def _list_index_files(self) -> list[tuple[str, str]]:
        """`(remote_id, name)` de los `index-*.json` de la carpeta biblioteca."""
        return self._list_small_files(INDEX_PREFIX)

    def _list_small_files(self, prefix: str) -> list[tuple[str, str]]:
        """`(remote_id, name)` de los archivos chicos con `prefix`."""
        raise NotImplementedError

    def _read_file(self, remote_id: str) -> bytes:
        """Bytes completos de un archivo chico del proveedor (el indice)."""
        raise NotImplementedError

    def _create_file(self, name: str, data: bytes) -> dict:
        """Crea un archivo chico en la carpeta biblioteca. Devuelve su metadata."""
        raise NotImplementedError

    def _replace_file(self, remote_id: str, data: bytes) -> dict:
        """Pisa el contenido de un archivo chico. Devuelve su metadata."""
        raise NotImplementedError

    def _upload(self, key: str, src: Path, size: int, media_type: str,
                existing_remote_id: str | None) -> tuple[str, str]:
        """Sube `src` a `key` y devuelve `(remote_id, revision)`.

        `existing_remote_id` es el archivo que ya ocupa `key`, o None si es
        nuevo. `size` es el tamano de `src`: el proveedor decide con eso si
        sube de una o por partes.
        """
        raise NotImplementedError

    def _open_stream(self, entry: IndexEntry, start: int,
                     n: int) -> Iterator[bytes]:
        """Abre la descarga y devuelve el cuerpo YA como iterador de `n` bytes.

        La request sale antes de devolver: una credencial revocada o la nube
        caida tienen que levantar aca, cuando `/api/audio` todavia puede
        contestar 503/502. Si saliera recien al iterar, los headers del 206 ya se
        habrian mandado y solo quedaria cortar la conexion.
        """
        raise NotImplementedError

    def _stream_whole(self, entry: IndexEntry) -> ContextManager[httpx.Response]:
        """Context manager con la descarga ENTERA de `entry` (para el prefetch).

        El proveedor lo arma con `contextlib.contextmanager`.
        """
        raise NotImplementedError

    def _trash(self, remote_id: str) -> None:
        """Manda el archivo a la papelera del proveedor."""
        raise NotImplementedError

    def _quota_remote(self) -> tuple[int | None, int]:
        """`(limit, usage)` de la cuenta en bytes. `limit` es None sin tope."""
        raise NotImplementedError

    def describe(self) -> str:
        """Etiqueta humana de donde vive la biblioteca (la muestra la UI)."""
        raise NotImplementedError
