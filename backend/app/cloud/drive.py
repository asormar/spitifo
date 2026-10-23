"""Adapter de `Storage` sobre Google Drive (ADR 0002, secciones 4, 5, 6 y 7).

Hereda de `CloudStorage` (`base.py`) el indice por dispositivo con su merge, la
cache, los reintentos y la lectura por rangos; aca vive la API v3 de Drive: la
carpeta visible `Spitifo` de My Drive, la busqueda con `q`, las subidas
`multipart` y `resumable`, `alt=media` + `Range` y `about.get` para la cuota.

Toda salida a la red va por el `httpx.Client` inyectado, asi los tests usan
`httpx.MockTransport` y nunca tocan internet. Modulo neutral: no importa
starlette ni uvicorn.
"""
from __future__ import annotations

import json
import os
import secrets
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import httpx

from .android import android_tokens, is_android
from .base import (
    CHUNK,
    FOLDER_NAME,
    INDEX_TTL,
    MAX_RETRIES,
    QUOTA_TTL,
    RETRY_STATUS,
    CloudStorage,
    QuotaExceeded,
    _parent,
    _RemoteBody,
    default_device_id,
    upload_ranges,
)
from .bench import _q
from .cache import AudioCache, default_cache_dir
from .library_index import IndexEntry
from .oauth import OAuthError, google_provider
from .tokens import (
    StoredTokenSource,
    TokenSource,
    TokenStore,
    default_data_dir,
    default_protector,
    default_token_dir,
)

DRIVE_FILES = "https://www.googleapis.com/drive/v3/files"
DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"
FOLDER_MIME = "application/vnd.google-apps.folder"

#: Un archivo mas chico que esto sube en una sola request (`multipart`).
MULTIPART_LIMIT = 5 * 1024 * 1024
#: 8 MiB por chunk: multiplo de 256 KiB, como exige el upload resumable.
UPLOAD_CHUNK = 8 * 1024 * 1024

#: Razones de un 403 que tambien son "rate limited" (ADR 0002, seccion 8).
RETRY_REASONS = frozenset({"rateLimitExceeded", "userRateLimitExceeded"})


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


# ------------------------------------------------------------------- adapter
class DriveStorage(CloudStorage):
    """`Storage` sobre Google Drive. Completa los hooks con la API v3."""

    # ------------------------------------------------------- errores de Drive
    def _is_retryable(self, resp: httpx.Response) -> bool:
        """Ademas de los status de siempre, un 403 `rateLimitExceeded`."""
        if super()._is_retryable(resp):
            return True
        return resp.status_code == 403 and _reason(resp) in RETRY_REASONS

    def _translate_error(self, resp: httpx.Response) -> None:
        if resp.status_code == 403 and _reason(resp) == "storageQuotaExceeded":
            raise QuotaExceeded("Google Drive: almacenamiento lleno")

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
    def _list_small_files(self, prefix: str) -> list[tuple[str, str]]:
        """`(remote_id, name)` de los archivos chicos con `prefix`."""
        root_id = self._folder_id("")
        resp = self._request("GET", DRIVE_FILES, params={
            "q": (f"name contains '{_q(prefix)}' and '{_q(root_id)}' in parents "
                  f"and trashed=false"),
            "fields": "files(id,name,modifiedTime)"})
        return [(str(entry["id"]), str(entry.get("name", "")))
                for entry in resp.json().get("files") or []]

    def _read_file(self, remote_id: str) -> bytes:
        """Bytes completos de un archivo chico (`alt=media`)."""
        with self._stream("GET", f"{DRIVE_FILES}/{remote_id}",
                          params={"alt": "media"}) as resp:
            return b"".join(resp.iter_bytes())

    def _create_file(self, name: str, data: bytes) -> dict:
        """Crea el archivo chico en la carpeta visible con `multipart`."""
        return self._multipart_create(name, [self._folder_id("")], data,
                                      "application/json")

    def _replace_file(self, remote_id: str, data: bytes) -> dict:
        """Pisa el contenido del archivo chico sin tocar la metadata."""
        resp = self._request("PATCH", f"{DRIVE_UPLOAD}/{remote_id}",
                             params={"uploadType": "media",
                                     "fields": "id,size,version,modifiedTime"},
                             content=data,
                             headers={"Content-Type": "application/json"})
        return resp.json()

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

    def _upload(self, key: str, src: Path, size: int, media_type: str,
                existing_remote_id: str | None) -> tuple[str, str]:
        """Sube `src` a `key` y devuelve `(remote_id, revision)` (el `version`)."""
        if existing_remote_id is not None:
            meta = self._upload_replace(existing_remote_id, src, size, media_type)
            remote_id = existing_remote_id
        else:
            folder_id = self._folder_id(_parent(key))
            name = key.rsplit("/", 1)[-1]
            meta = self._upload_new(name, folder_id, src, size, media_type)
            remote_id = str(meta["id"])
        return remote_id, str(meta.get("version", "")) or "0"

    # ------------------------------------------------------------------ descargas
    def _open_stream(self, entry: IndexEntry, start: int,
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

    @contextmanager
    def _stream_whole(self, entry: IndexEntry) -> Iterator[httpx.Response]:
        """Descarga entera de `entry` en streaming (`alt=media`)."""
        with self._stream("GET", f"{DRIVE_FILES}/{entry.remote_id}",
                          params={"alt": "media"}) as resp:
            yield resp

    # -------------------------------------------------------------------- borrado
    def _trash(self, remote_id: str) -> None:
        """Manda el archivo a la papelera: NULLA en vez de borrar de verdad."""
        self._request("PATCH", f"{DRIVE_FILES}/{remote_id}",
                      json={"trashed": True})

    # ---------------------------------------------------------------------- cuota
    def _quota_remote(self) -> tuple[int | None, int]:
        """`(limit, usage)` de `about.get`. Funciona con el scope `drive.file`.

        `usage` es todo lo de la cuenta (Drive, Gmail y Fotos comparten los
        15 GB); `limit` es None en cuentas sin tope.
        """
        resp = self._request("GET", "https://www.googleapis.com/drive/v3/about",
                             params={"fields": "storageQuota"})
        sq = resp.json().get("storageQuota") or {}
        limit = sq.get("limit")
        return (int(limit) if limit else None, int(sq.get("usage") or 0))

    def describe(self) -> str:
        return f"Google Drive: {self.folder_name}"


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
