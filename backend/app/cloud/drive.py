"""Adapter de `Storage` sobre Google Drive (ADR 0002, secciones 4, 5, 6 y 7).

La biblioteca vive en la carpeta visible `Spitifo` de My Drive, con las carpetas
del usuario espejadas debajo. El indice NO esta en un solo `index.json`:
Drive API v3 no tiene `If-Match`, asi que cada dispositivo escribe SOLO su
`index-<device_id>.json` (un unico escritor por archivo, sin conflictos) y la
biblioteca es el merge de todos esos indices (`LibraryIndex.merge`: gana el
`updated_at` mas nuevo; los tombstones evitan resucitar un borrado).

Toda salida a la red va por el `httpx.Client` inyectado, asi los tests usan
`httpx.MockTransport` y nunca tocan internet. Modulo neutral: no importa
starlette ni uvicorn.
"""
from __future__ import annotations

import json
import logging
import mimetypes
import os
import secrets
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator

import httpx

from ..config import AUDIO_EXTS
from ..storage import StoredFile, validate_key
from .android import android_tokens, is_android
from .bench import _q, upload_ranges
from .cache import AudioCache, default_cache_dir
from .library_index import IndexEntry, IndexFormatError, LibraryIndex
from .oauth import OAuthError, google_provider
from .tokens import (
    StoredTokenSource,
    TokenSource,
    TokenStore,
    default_data_dir,
    default_protector,
    default_token_dir,
)

log = logging.getLogger(__name__)

DRIVE_FILES = "https://www.googleapis.com/drive/v3/files"
DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"
FOLDER_MIME = "application/vnd.google-apps.folder"
#: Carpeta visible que crea la app (ADR 0002, seccion 1).
FOLDER_NAME = "Spitifo"

#: Un archivo mas chico que esto sube en una sola request (`multipart`).
MULTIPART_LIMIT = 5 * 1024 * 1024
#: 8 MiB por chunk: multiplo de 256 KiB, como exige el upload resumable.
UPLOAD_CHUNK = 8 * 1024 * 1024
#: Tamano de cada lectura de `open_range`, igual que el adapter local.
CHUNK = 64 * 1024

#: Cuanto vale el indice en memoria antes de releerlo de Drive.
INDEX_TTL = 30.0
#: Cuanto vale la cuota en memoria: la pantalla de conexion la pide al abrirse
#: y mientras espera el sign-in, no hace falta preguntarle a Drive cada vez.
QUOTA_TTL = 60.0
#: Status que se reintentan solos, con backoff.
RETRY_STATUS = frozenset({429, 500, 502, 503, 504})
#: Razones de un 403 que tambien son "rate limited" (ADR 0002, seccion 8).
RETRY_REASONS = frozenset({"rateLimitExceeded", "userRateLimitExceeded"})
MAX_RETRIES = 3


class QuotaExceeded(RuntimeError):
    """Google Drive esta lleno: la UI avisa y la pista se queda local."""


# ------------------------------------------------------------------- ayudantes
def _reason(resp: httpx.Response) -> str | None:
    """`error.errors[0].reason` de un error de Drive, o None."""
    try:
        payload = resp.json()
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if isinstance(error, dict):
        errors = error.get("errors")
        if isinstance(errors, list) and errors and isinstance(errors[0], dict):
            found = errors[0].get("reason")
            if found:
                return str(found)
        found = error.get("reason")
        if found:
            return str(found)
    return None


def _folder_query(parent_id: str, name: str) -> str:
    return (f"name='{_q(name)}' and mimeType='{FOLDER_MIME}' "
            f"and '{_q(parent_id)}' in parents and trashed=false")


def _parent(key: str) -> str:
    return key.rsplit("/", 1)[0] if "/" in key else ""


def _ext_of(key: str) -> str:
    name = key.rsplit("/", 1)[-1]
    if "." not in name:
        return ""
    return name.rsplit(".", 1)[-1].upper()


def _mime_of(key: str) -> str:
    return mimetypes.guess_type(key)[0] or "application/octet-stream"


def _multipart_body(boundary: str, metadata: bytes, media: bytes,
                    media_type: str) -> bytes:
    """Cuerpo `multipart/related` de un upload chico: metadata + media."""
    b = boundary.encode("ascii")
    return b"".join([
        b"--", b, b"\r\n",
        b"Content-Type: application/json; charset=UTF-8\r\n\r\n",
        metadata, b"\r\n",
        b"--", b, b"\r\n",
        f"Content-Type: {media_type}\r\n\r\n".encode("ascii"),
        media, b"\r\n",
        b"--", b, b"--\r\n",
    ])


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


# ------------------------------------------------------------------- adapter
class DriveStorage:
    """`Storage` sobre Google Drive. Implementa el puerto de `..storage`."""

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
        self._folders: dict[str, str] = {}
        self._index: LibraryIndex | None = None
        self._index_at = float("-inf")
        self._own = LibraryIndex()
        self._own_index_id: str | None = None
        # True si el indice PROPIO existe pero no se pudo leer: escribirlo asi
        # lo pisaria con una copia casi vacia y se perderia la biblioteca.
        self._own_unreadable = False
        self._quota_cache: dict | None = None
        self._quota_cache_at = float("-inf")
        # Prefetch del proximo tema: el par (remote_id, revision) que YA se esta
        # bajando, para que dos avisos seguidos de la UI no lo bajen dos veces.
        self._prefetch_lock = threading.Lock()
        self._prefetching: set[tuple[str, str]] = set()

    # --------------------------------------------------------- HTTP con reintentos
    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.tokens.access_token()}"}

    def _retryable(self, resp: httpx.Response) -> bool:
        if resp.status_code in RETRY_STATUS:
            return True
        return resp.status_code == 403 and _reason(resp) in RETRY_REASONS

    def _delay(self, resp: httpx.Response, attempt: int) -> float:
        retry_after = resp.headers.get("Retry-After")
        if retry_after:
            try:
                return max(0.0, float(retry_after))
            except ValueError:
                pass
        return float(min(2 ** attempt, 8))

    def _quota(self, resp: httpx.Response) -> None:
        if resp.status_code == 403 and _reason(resp) == "storageQuotaExceeded":
            raise QuotaExceeded("Google Drive: almacenamiento lleno")

    def _request(self, method: str, url: str, expect: tuple[int, ...] = (),
                 **kw) -> httpx.Response:
        """Request con bearer, un reintento ante 401 y backoff ante 429/5xx.

        Un 401 pide un token nuevo al origen y reintenta UNA vez (ADR 0002,
        seccion 8). Los 429 y los 5xx se reintentan hasta `MAX_RETRIES`
        respetando `Retry-After`. Un 403 `storageQuotaExceeded` corta con
        `QuotaExceeded`. `expect` lista status no-2xx que son respuesta valida
        (p. ej. el `308` de una sesion resumable a medio subir): no cortan.
        """
        headers = dict(kw.pop("headers", None) or {})
        headers.update(self._auth())
        attempt = 0
        retried_auth = False
        while True:
            resp = self.client.request(method, url, headers=headers, **kw)
            if resp.status_code == 401 and not retried_auth:
                self.tokens.invalidate()
                headers.update(self._auth())
                retried_auth = True
                continue
            if self._retryable(resp) and attempt < MAX_RETRIES:
                self.sleep(self._delay(resp, attempt))
                attempt += 1
                continue
            self._quota(resp)
            if resp.status_code not in expect:
                resp.raise_for_status()
            return resp

    @contextmanager
    def _stream(self, method: str, url: str, **kw) -> Iterator[httpx.Response]:
        """Como `_request` pero en streaming: el 401 se reintenta antes del body."""
        headers = dict(kw.pop("headers", None) or {})
        headers.update(self._auth())
        attempt = 0
        retried_auth = False
        while True:
            request = self.client.build_request(method, url, headers=headers,
                                                **kw)
            resp = self.client.send(request, stream=True)
            if resp.status_code == 401 and not retried_auth:
                resp.close()
                self.tokens.invalidate()
                headers.update(self._auth())
                retried_auth = True
                continue
            if self._retryable(resp) and attempt < MAX_RETRIES:
                delay = self._delay(resp, attempt)
                resp.close()
                self.sleep(delay)
                attempt += 1
                continue
            break
        try:
            self._quota(resp)
            resp.raise_for_status()
            yield resp
        finally:
            resp.close()

    def _download_all(self, file_id: str) -> bytes:
        with self._stream("GET", f"{DRIVE_FILES}/{file_id}",
                          params={"alt": "media"}) as resp:
            return b"".join(resp.iter_bytes())

    # ------------------------------------------------------------------ carpetas
    def _find_child(self, parent_id: str, name: str) -> str | None:
        resp = self._request("GET", DRIVE_FILES, params={
            "q": _folder_query(parent_id, name), "fields": "files(id,name)"})
        files = resp.json().get("files") or []
        return str(files[0]["id"]) if files else None

    def _create_folder(self, parent_id: str, name: str) -> str:
        resp = self._request("POST", DRIVE_FILES, json={
            "name": name, "mimeType": FOLDER_MIME, "parents": [parent_id]})
        return str(resp.json()["id"])

    def _folder_id(self, rel: str) -> str:
        """Id de la carpeta `rel` bajo `Spitifo` ("" es `Spitifo` misma).

        Bajo el lock: dos descargas del mismo artista a la vez crearian dos
        carpetas con el mismo nombre (Drive lo permite).
        """
        with self._lock:
            return self._folder_id_locked(rel)

    def _folder_id_locked(self, rel: str) -> str:
        cached = self._folders.get(rel)
        if cached:
            return cached
        if rel == "":
            parent, name = "root", self.folder_name
        else:
            parts = rel.split("/")
            parent, name = self._folder_id_locked("/".join(parts[:-1])), parts[-1]
        found = self._find_child(parent, name)
        folder_id = found if found else self._create_folder(parent, name)
        self._folders[rel] = folder_id
        return folder_id

    # --------------------------------------------------------------------- indice
    def _own_name(self) -> str:
        return f"index-{self.device_id}.json"

    def _load_index(self, force: bool = False) -> LibraryIndex:
        """Merge de todos los `index-*.json` de `Spitifo`, con TTL en memoria.

        Un indice que no parsea se saltea y se loguea: no puede tumbar la
        biblioteca entera. Se recuerda, ademas, el id del indice PROPIO.
        """
        with self._lock:
            if (not force and self._index is not None
                    and (self._clock() - self._index_at) < INDEX_TTL):
                return self._index
            root_id = self._folder_id("")
            resp = self._request("GET", DRIVE_FILES, params={
                "q": (f"name contains 'index-' and '{_q(root_id)}' in parents "
                      f"and trashed=false"),
                "fields": "files(id,name,modifiedTime)"})
            merged = LibraryIndex()
            own = LibraryIndex()
            own_id: str | None = None
            own_unreadable = False
            for entry in resp.json().get("files") or []:
                name = str(entry.get("name", ""))
                if not name.startswith("index-"):
                    continue
                try:
                    parsed = LibraryIndex.from_bytes(
                        self._download_all(str(entry["id"])))
                except (httpx.HTTPError, IndexFormatError) as exc:
                    log.warning("indice ilegible %s: %s", name, exc)
                    if name == self._own_name():
                        own_id = str(entry["id"])
                        own_unreadable = True
                    continue
                merged = merged.merge(parsed)
                if name == self._own_name():
                    own_id = str(entry["id"])
                    own = parsed
            self._index = merged
            self._index_at = self._clock()
            self._own_index_id = own_id
            self._own = own
            self._own_unreadable = own_unreadable
            return merged

    def _write_own(self, change: Callable[[LibraryIndex], None]) -> None:
        """Aplica `change` al indice PROPIO y lo sube a Drive.

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
                self._request("PATCH", f"{DRIVE_UPLOAD}/{self._own_index_id}",
                              params={"uploadType": "media",
                                      "fields": "id,size,version,modifiedTime"},
                              content=body,
                              headers={"Content-Type": "application/json"})
            else:
                created = self._multipart_create(
                    self._own_name(), [self._folder_id("")], body,
                    "application/json")
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
        cada seek y no puede esperar a releer todos los indices de Drive.
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

    # ------------------------------------------------------------------- subidas
    def _multipart_create(self, name: str, parents: list[str], data: bytes,
                          media_type: str) -> dict:
        boundary = "spitifo-" + secrets.token_hex(16)
        metadata = json.dumps({"name": name, "parents": parents}).encode("utf-8")
        resp = self._request(
            "POST", DRIVE_UPLOAD,
            params={"uploadType": "multipart",
                    "fields": "id,size,version,modifiedTime"},
            content=_multipart_body(boundary, metadata, data, media_type),
            headers={"Content-Type": f'multipart/related; boundary="{boundary}"'})
        return resp.json()

    def _resumable(self, method: str, url: str, metadata: dict, src: Path,
                   size: int, media_type: str) -> dict:
        """Sesion resumable: abre con Location y sube en chunks de `UPLOAD_CHUNK`."""
        start = self._request(
            method, url,
            params={"uploadType": "resumable",
                    "fields": "id,size,version,modifiedTime"},
            json=metadata,
            headers={"Content-Type": "application/json",
                     "X-Upload-Content-Type": media_type,
                     "X-Upload-Content-Length": str(size)})
        location = start.headers.get("Location")
        if not location:
            raise OAuthError("Drive no devolvio el header Location de la sesion")
        last: httpx.Response | None = None
        with open(src, "rb") as f:
            for ini, fin in upload_ranges(size, UPLOAD_CHUNK):
                f.seek(ini)
                last = self._request(
                    "PUT", location, expect=(308,),
                    content=f.read(fin - ini + 1),
                    headers={"Content-Range": f"bytes {ini}-{fin}/{size}",
                             "Content-Type": media_type})
        if last is None:
            raise OAuthError("Drive: la subida resumable no mando ninguna parte")
        return last.json()

    def _upload_new(self, name: str, folder_id: str, src: Path, size: int,
                    media_type: str) -> dict:
        if size <= MULTIPART_LIMIT:
            return self._multipart_create(name, [folder_id], src.read_bytes(),
                                          media_type)
        return self._resumable("POST", DRIVE_UPLOAD,
                               {"name": name, "parents": [folder_id]},
                               src, size, media_type)

    def _upload_replace(self, file_id: str, src: Path, size: int,
                        media_type: str) -> dict:
        if size <= MULTIPART_LIMIT:
            resp = self._request(
                "PATCH", f"{DRIVE_UPLOAD}/{file_id}",
                params={"uploadType": "media",
                        "fields": "id,size,version,modifiedTime"},
                content=src.read_bytes(),
                headers={"Content-Type": media_type})
            return resp.json()
        return self._resumable("PATCH", f"{DRIVE_UPLOAD}/{file_id}", {},
                               src, size, media_type)

    # ---------------------------------------------------------------------- puerto
    def list(self) -> list[StoredFile]:
        exts = {e.lower() for e in AUDIO_EXTS}
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
                                  duration=entry.duration))
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
        return self._open_remote(entry, start, n)

    def _open_remote(self, entry: IndexEntry, start: int,
                     n: int) -> Iterator[bytes]:
        """Abre la descarga YA y devuelve el cuerpo como iterador.

        La request sale antes de devolver: un token revocado o Drive caido
        levanta aca, cuando `/api/audio` todavia puede contestar 503/502. Si
        saliera recien al iterar, los headers del 206 ya se habrian mandado y
        solo quedaria cortar la conexion.
        """
        if n <= 0:
            return iter(())
        end = start + n - 1
        stream = self._stream("GET", f"{DRIVE_FILES}/{entry.remote_id}",
                              params={"alt": "media"},
                              headers={"Range": f"bytes={start}-{end}"})
        resp = stream.__enter__()
        try:
            whole = start == 0 and n == entry.size
            if resp.status_code != 206 and not (
                    resp.status_code == 200 and whole):
                raise httpx.HTTPStatusError(
                    f"Drive devolvio {resp.status_code} para un rango",
                    request=resp.request, response=resp)
        except BaseException:
            stream.__exit__(None, None, None)
            raise
        return _RemoteBody(stream, resp, n)

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
            # archivo entero en memoria (eso es `_download_all`, solo para el indice).
            with os.fdopen(fd, "wb") as out:
                with self._stream("GET", f"{DRIVE_FILES}/{entry.remote_id}",
                                  params={"alt": "media"}) as resp:
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
        title, artist, album, duration = _read_tags(src)

        existing = self._entry(key)
        if existing is not None:
            meta = self._upload_replace(existing.remote_id, src, size, media_type)
            remote_id = existing.remote_id
        else:
            folder_id = self._folder_id(_parent(key))
            name = key.rsplit("/", 1)[-1]
            meta = self._upload_new(name, folder_id, src, size, media_type)
            remote_id = str(meta["id"])
        revision = str(meta.get("version", "")) or "0"

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
        self._request("PATCH", f"{DRIVE_FILES}/{entry.remote_id}",
                      json={"trashed": True})
        self._write_own(lambda index: index.remove(key, self._clock()))
        if self.cache is not None:
            self.cache.unpin(entry.remote_id, entry.revision)

    def describe(self) -> str:
        return f"Google Drive: {self.folder_name}"

    def quota(self) -> dict:
        """Espacio de la cuenta: `{limit, usage, app}` en bytes.

        `limit` es None en cuentas sin tope. `usage` es todo lo de la cuenta
        (Drive, Gmail y Fotos comparten los 15 GB); `app` es lo que ocupa la
        biblioteca de Spitifo, sumado desde el indice sin otra llamada.
        `about.get` funciona con el scope `drive.file`.
        """
        with self._lock:
            if self._quota_cache is not None and (
                    self._clock() - self._quota_cache_at) < QUOTA_TTL:
                return dict(self._quota_cache)
        resp = self._request("GET", "https://www.googleapis.com/drive/v3/about",
                             params={"fields": "storageQuota"})
        sq = resp.json().get("storageQuota") or {}
        limit = sq.get("limit")
        app = sum(f.size for f in self.list())
        quota = {"limit": int(limit) if limit else None,
                 "usage": int(sq.get("usage") or 0), "app": app}
        with self._lock:
            self._quota_cache = quota
            self._quota_cache_at = self._clock()
        return dict(quota)


def drive_storage_from_env() -> DriveStorage:
    """Arma el adapter de Drive con la configuracion del entorno.

    UN cliente HTTP de vida larga compartido por el origen de tokens, las
    descargas y las subidas: reusar la conexion TLS es lo que mantiene el primer
    audio por debajo de 1 s (ADR 0002, actualizacion de la sesion 7).

    El origen del token depende de la plataforma: en la PC sale del
    `oauth_clients.json` + `TokenStore` + refresh; en Android lo empuja Kotlin al
    `StaticTokenSource` del proceso, y ese archivo no se lee nunca (ahi no hay
    client secret que leer).
    """
    tokens: TokenSource
    if is_android():
        tokens = android_tokens()
        client = httpx.Client(timeout=httpx.Timeout(60.0, connect=15.0),
                              follow_redirects=False)
    else:
        provider = google_provider()
        store = TokenStore(default_token_dir(), default_protector())
        client = httpx.Client(timeout=httpx.Timeout(60.0, connect=15.0),
                              follow_redirects=False)
        tokens = StoredTokenSource(provider, store, provider.name, client)
    cache = AudioCache(
        default_cache_dir(),
        budget_bytes=int(os.getenv("SPITIFO_CACHE_BYTES", 2 * 1024 ** 3)))
    device_id = default_device_id(default_data_dir())
    return DriveStorage(tokens, client, device_id, cache=cache)
