"""Doble en memoria de la API de Google Drive v3 que usa `DriveStorage`.

Es un handler de `httpx.MockTransport`: se construye un `FakeDrive` y se pasa
`httpx.MockTransport(fake)`. Cubre solo lo que el adapter toca: `files.list` con
las formas de `q` que arma, creacion de carpetas, subida `multipart`, subida
resumable (`308` y despues `200`), actualizacion de media y metadata, y descarga
con `Range`. Lleva contadores por endpoint para probar que `stat` no golpea la
red, y permite inyectar 401, 429 (`Retry-After`) y 403 `storageQuotaExceeded`.
"""
from __future__ import annotations

import json
import re
import time

import httpx

#: Valor entre comillas simples de un `q`, con escapes de Drive (`\'`, `\\`).
_VALUE = r"'((?:[^'\\]|\\.)*)'"
_NAME_EQ = re.compile(r"^name=" + _VALUE + r"$")
_NAME_CONTAINS = re.compile(r"^name\s+contains\s+" + _VALUE + r"$")
_MIME_EQ = re.compile(r"^mimeType=" + _VALUE + r"$")
_PARENT = re.compile(r"^" + _VALUE + r"\s+in\s+parents$")
_TRASHED = re.compile(r"^trashed=(true|false)$")
_CONTENT_RANGE = re.compile(r"^bytes (\d+)-(\d+)/(\d+)$")


def _unescape(value: str) -> str:
    """Saca los escapes de `_q` (`\\` y `\\'`) respetando el orden."""
    out: list[str] = []
    i = 0
    while i < len(value):
        if value[i] == "\\" and i + 1 < len(value):
            out.append(value[i + 1])
            i += 2
        else:
            out.append(value[i])
            i += 1
    return "".join(out)


def parse_query(q: str) -> list[tuple[str, object]]:
    """Terminos de un `q` de Drive: (kind, valor). Solo las formas que usamos."""
    terms: list[tuple[str, object]] = []
    for raw in re.split(r"\s+and\s+", q.strip()):
        part = raw.strip()
        match = _NAME_CONTAINS.match(part)
        if match:
            terms.append(("name_contains", _unescape(match.group(1))))
            continue
        match = _NAME_EQ.match(part)
        if match:
            terms.append(("name", _unescape(match.group(1))))
            continue
        match = _MIME_EQ.match(part)
        if match:
            terms.append(("mime", _unescape(match.group(1))))
            continue
        match = _PARENT.match(part)
        if match:
            terms.append(("parent", _unescape(match.group(1))))
            continue
        match = _TRASHED.match(part)
        if match:
            terms.append(("trashed", match.group(1) == "true"))
            continue
        raise ValueError(f"q no soportada por el fake: {part!r}")
    return terms


def split_multipart(body: bytes, boundary: str) -> list[dict]:
    """Partes de un cuerpo `multipart/related`: [{type, data}, ...]."""
    delim = b"--" + boundary.encode("ascii")
    parts: list[dict] = []
    for chunk in body.split(delim):
        if chunk.startswith(b"--"):
            continue
        # Se saca UN CRLF de cada punta: es el separador que pone el escritor.
        if chunk.startswith(b"\r\n"):
            chunk = chunk[2:]
        if chunk.endswith(b"\r\n"):
            chunk = chunk[:-2]
        if not chunk:
            continue
        headers, sep, data = chunk.partition(b"\r\n\r\n")
        if not sep:
            continue
        content_type = ""
        for line in headers.split(b"\r\n"):
            if line.lower().startswith(b"content-type:"):
                content_type = line.split(b":", 1)[1].strip().decode("ascii")
        parts.append({"type": content_type, "data": data})
    return parts


def _iso(ts: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


class FakeDrive:
    """Drive v3 en memoria. Se usa directo como handler de `MockTransport`."""

    def __init__(self) -> None:
        self.files: dict[str, dict] = {}
        self.sessions: dict[str, dict] = {}
        self._next_id = 1
        self._next_session = 1
        #: Orden de llegada de (metodo, path), para contar llamadas de red.
        self.calls: list[tuple[str, str]] = []
        #: Contadores por `"<METODO> <path>"`.
        self.counters: dict[str, int] = {}
        #: Inyeccion de fallos. `fail_401`/`fail_429` son "las proximas N".
        self.fail_401 = 0
        self.fail_429 = 0
        self.retry_after: str | None = None
        self.quota = False
        #: Si esta, maneja TODAS las requests (p. ej. levantar ConnectError).
        self.fail_with = None
        #: Cuantas subidas usaron cada camino.
        self.resumable_sessions = 0
        self.multipart_uploads = 0

    # ------------------------------------------------------------- utilidades
    @property
    def resumable_puts(self) -> int:
        """Cuantos chunks subio la sesion resumable (PUT al Location)."""
        return sum(n for key, n in self.counters.items()
                   if key.startswith("PUT /upload-session/"))

    def reset_calls(self) -> None:
        self.calls.clear()
        self.counters.clear()

    def data_of(self, file_id: str) -> bytes:
        return self.files[file_id]["data"]

    def _add(self, name: str, parents: list[str], mime: str, data: bytes = b"",
             version: int = 1) -> str:
        file_id = f"f{self._next_id}"
        self._next_id += 1
        self.files[file_id] = {
            "name": name,
            "parents": list(parents),
            "mimeType": mime,
            "data": bytes(data),
            "version": version,
            "trashed": False,
            "modifiedTime": time.time(),
        }
        return file_id

    def _public(self, file_id: str, f: dict, fields: str = "") -> dict:
        data = {
            "id": file_id,
            "name": f["name"],
            "mimeType": f["mimeType"],
            "parents": list(f["parents"]),
            "size": str(len(f["data"])),
            "version": str(f["version"]),
            "modifiedTime": _iso(f["modifiedTime"]),
            "trashed": bool(f["trashed"]),
        }
        if not fields:
            return data
        asked = {p.strip() for p in fields.replace("files(", "").rstrip(")")
                 .split(",") if p.strip()}
        return {k: v for k, v in data.items() if k in asked}

    @staticmethod
    def _match(f: dict, terms: list[tuple[str, object]]) -> bool:
        for kind, value in terms:
            if kind == "name" and f["name"] != value:
                return False
            if kind == "name_contains" and str(value) not in f["name"]:
                return False
            if kind == "mime" and f["mimeType"] != value:
                return False
            if kind == "parent" and value not in f["parents"]:
                return False
            if kind == "trashed" and bool(f["trashed"]) != value:
                return False
        return True

    # --------------------------------------------------------------- handler
    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append((request.method, request.url.path))
        if self.fail_with is not None:
            return self.fail_with(request)
        key = f"{request.method} {request.url.path}"
        self.counters[key] = self.counters.get(key, 0) + 1

        if self.fail_401 > 0:
            self.fail_401 -= 1
            return httpx.Response(401, json={
                "error": {"code": 401, "message": "Invalid Credentials"}})
        if self.fail_429 > 0:
            self.fail_429 -= 1
            headers = {}
            if self.retry_after is not None:
                headers["Retry-After"] = self.retry_after
            return httpx.Response(429, headers=headers, json={
                "error": {"code": 429, "message": "Rate Limit Exceeded"}})
        if self.quota:
            return httpx.Response(403, json={"error": {
                "code": 403,
                "errors": [{"reason": "storageQuotaExceeded"}]}})

        try:
            return self._route(request)
        except KeyError as exc:
            return httpx.Response(404, json={
                "error": {"code": 404, "message": str(exc)}})

    def _route(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        params = request.url.params
        if path == "/drive/v3/files" and method == "GET":
            return self._list(request)
        if path == "/drive/v3/files" and method == "POST":
            return self._create_metadata(request)
        if path.startswith("/drive/v3/files/"):
            file_id = path.rsplit("/", 1)[-1]
            if method == "GET" and params.get("alt") == "media":
                return self._download(request, file_id)
            if method == "GET":
                return httpx.Response(200, json=self._public(
                    file_id, self.files[file_id]))
            if method == "PATCH":
                return self._patch_metadata(request, file_id)
        if path == "/upload/drive/v3/files" and method == "POST":
            upload_type = params.get("uploadType")
            if upload_type == "multipart":
                return self._multipart(request)
            if upload_type == "resumable":
                return self._start_session(request, None)
        if path.startswith("/upload/drive/v3/files/") and method == "PATCH":
            file_id = path.rsplit("/", 1)[-1]
            upload_type = params.get("uploadType")
            if upload_type == "media":
                return self._media_update(request, file_id)
            if upload_type == "resumable":
                return self._start_session(request, file_id)
        if path.startswith("/upload-session/") and method in ("PUT", "POST"):
            return self._upload_chunk(request, path.rsplit("/", 1)[-1])
        raise KeyError(f"ruta no soportada: {method} {path}")

    # ------------------------------------------------------------- endpoints
    def _list(self, request: httpx.Request) -> httpx.Response:
        terms = parse_query(request.url.params.get("q", ""))
        fields = request.url.params.get("fields", "")
        files = [self._public(fid, f, fields)
                 for fid, f in self.files.items() if self._match(f, terms)]
        return httpx.Response(200, json={"files": files})

    def _create_metadata(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        file_id = self._add(body["name"], body.get("parents") or ["root"],
                            body.get("mimeType", "application/octet-stream"))
        return httpx.Response(200, json=self._public(file_id,
                                                     self.files[file_id]))

    def _patch_metadata(self, request: httpx.Request,
                        file_id: str) -> httpx.Response:
        f = self.files[file_id]
        body = json.loads(request.content or b"{}")
        if "trashed" in body:
            f["trashed"] = bool(body["trashed"])
        if "name" in body:
            f["name"] = str(body["name"])
        f["modifiedTime"] = time.time()
        return httpx.Response(200, json=self._public(file_id, f))

    def _download(self, request: httpx.Request,
                  file_id: str) -> httpx.Response:
        data = self.files[file_id]["data"]
        header = request.headers.get("Range")
        match = re.match(r"^bytes=(\d+)-(\d+)$", header or "")
        if match:
            start, end = int(match.group(1)), int(match.group(2))
            body = data[start:end + 1]
            return httpx.Response(206, headers={
                "Content-Range": f"bytes {start}-{end}/{len(data)}",
                "Content-Length": str(len(body)),
                "Accept-Ranges": "bytes"}, content=body)
        return httpx.Response(200, headers={
            "Content-Length": str(len(data))}, content=data)

    def _media_update(self, request: httpx.Request,
                      file_id: str) -> httpx.Response:
        f = self.files[file_id]
        f["data"] = request.content
        f["version"] += 1
        f["modifiedTime"] = time.time()
        return httpx.Response(200, json=self._public(
            file_id, f, "id,size,version,modifiedTime"))

    def _multipart(self, request: httpx.Request) -> httpx.Response:
        self.multipart_uploads += 1
        ctype = request.headers.get("Content-Type", "")
        match = re.search(r'boundary="?([^";]+)"?', ctype)
        if not match:
            return httpx.Response(400, json={"error": {"message": "no boundary"}})
        parts = split_multipart(request.content, match.group(1))
        meta = json.loads(parts[0]["data"])
        media = parts[1]["data"] if len(parts) > 1 else b""
        media_type = parts[1]["type"] if len(parts) > 1 else "application/json"
        file_id = self._add(meta["name"], meta.get("parents") or ["root"],
                            media_type, data=media)
        return httpx.Response(200, json=self._public(
            file_id, self.files[file_id], "id,size,version,modifiedTime"))

    def _start_session(self, request: httpx.Request,
                       file_id: str | None) -> httpx.Response:
        self.resumable_sessions += 1
        meta: dict = {}
        if request.content:
            try:
                meta = json.loads(request.content)
            except ValueError:
                meta = {}
        sid = f"s{self._next_session}"
        self._next_session += 1
        self.sessions[sid] = {
            "file_id": file_id,
            "name": meta.get("name"),
            "parents": meta.get("parents") or ["root"],
            "mimeType": request.headers.get(
                "X-Upload-Content-Type", "application/octet-stream"),
            "buffer": bytearray(),
        }
        return httpx.Response(200, headers={
            "Location": f"https://upload.example/upload-session/{sid}"})

    def _upload_chunk(self, request: httpx.Request,
                      sid: str) -> httpx.Response:
        session = self.sessions[sid]
        header = request.headers.get("Content-Range", "")
        match = _CONTENT_RANGE.match(header)
        data = request.content
        if match:
            start, end, total = (int(match.group(1)), int(match.group(2)),
                                 int(match.group(3)))
        else:
            start, end, total = 0, len(data) - 1, len(data)
        buf = session["buffer"]
        if len(buf) < end + 1:
            buf.extend(b"\x00" * (end + 1 - len(buf)))
        buf[start:end + 1] = data
        if end + 1 < total:
            return httpx.Response(308, headers={"Range": f"bytes=0-{end}"})
        if session["file_id"]:
            file_id = session["file_id"]
            f = self.files[file_id]
            f["data"] = bytes(buf)
            f["version"] += 1
            f["modifiedTime"] = time.time()
        else:
            file_id = self._add(session["name"], session["parents"],
                                session["mimeType"], data=bytes(buf))
        return httpx.Response(200, json=self._public(
            file_id, self.files[file_id], "id,size,version,modifiedTime"))
