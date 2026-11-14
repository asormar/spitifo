"""Veredicto y procedencia de cada archivo descargado.

El veredicto (`identify.verdict`) existe en el momento de la descarga y en
ningun otro: no se puede recalcular despues desde el archivo. Se guarda por
dispositivo y por mes, igual que el historial de escucha:

    fileinfo-<device>-YYYY-MM.json    {"version": 1, "files": {<clave>: {...}}}

Cada dispositivo escribe SOLO sus archivos y la vista se arma mergeando todos
(gana el `at` mas nuevo por clave). Un archivo viejo, o copiado a mano, no tiene
registro: la API simplemente no emite sus campos. Este modulo es la parte pura
(validacion, armado del registro, el join con la lista) y el mixin que usan los
dos adapters con sus hooks de archivo.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field

from .identify import similarity, verdict as identify_verdict
from .listens import month_of

log = logging.getLogger(__name__)

#: Version del formato. Un major distinto se rechaza en vez de adivinar.
VERSION = 1

FILEINFO_PREFIX = "fileinfo-"
_FILEINFO_FILE_RE = re.compile(
    r"^" + re.escape(FILEINFO_PREFIX)
    + r"(?P<dev>.+)-(?P<month>\d{4}-\d{2})\.json$")

#: Los cuatro valores que ya devuelve `identify.verdict`. `unknown` tambien es
#: "no se pudo formar un veredicto" (Jamendo, Wikimedia, un enlace pegado).
VERDICTS = frozenset({"match", "partial", "mismatch", "unknown"})
SOURCES = frozenset({"itunes", "archive", "wikimedia", "jamendo", "youtube"})
REAL_BY = frozenset({"tags", "item", "video"})

#: Cuanto vale la vista en memoria antes de releer los archivos.
TTL = 30.0

MAX_TEXT = 200
MAX_URL = 300


class FileInfoFormatError(ValueError):
    """El `fileinfo-*` guardado no tiene el formato que se entiende."""


# ---------------------------------------------------------------- validacion
def _int(value: object) -> int | None:
    """Entero no negativo de verdad (`bool` no cuenta)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float) and value >= 0 and value == int(value):
        return int(value)
    return None


def _text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())
    return value[:MAX_TEXT] if value else None


def _url(value: object) -> str | None:
    """Solo http(s) y corta: lo demas se descarta, no tira el registro."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    if len(value) > MAX_URL or not re.match(r"^https?://\S+$", value):
        return None
    return value


def clean_record(raw: object) -> dict | None:
    """Registro valido o None. Un enum desconocido tira el registro entero."""
    if not isinstance(raw, dict):
        return None
    verdict = raw.get("verdict")
    meta = raw.get("meta")
    file = raw.get("file")
    at = _int(raw.get("at"))
    size = _int(raw.get("bytes"))
    if verdict not in VERDICTS or meta not in SOURCES or file not in SOURCES:
        return None
    if at is None or size is None:
        return None
    out: dict = {"verdict": verdict, "at": at, "bytes": size,
                 "meta": meta, "file": file}
    for name in ("meta_url", "file_url"):
        value = _url(raw.get(name))
        if value:
            out[name] = value
    for name in ("title", "artist", "real"):
        value = _text(raw.get(name))
        if value:
            out[name] = value
    real_by = raw.get("real_by")
    if real_by in REAL_BY and "real" in out:
        out["real_by"] = real_by
    score = raw.get("score")
    if (isinstance(score, (int, float)) and not isinstance(score, bool)
            and 0 <= score <= 1):
        out["score"] = round(float(score), 2)
    return out


# ------------------------------------------------------------ nombres de archivo
def fileinfo_file(device: str, month: str) -> str:
    return f"{FILEINFO_PREFIX}{device}-{month}.json"


def parse_fileinfo_file(name: str) -> tuple[str, str] | None:
    """`(device, month)` desde `fileinfo-<dev>-YYYY-MM.json`, o None."""
    found = _FILEINFO_FILE_RE.match(name)
    if not found:
        return None
    return found.group("dev"), found.group("month")


# ------------------------------------------------------------------- serializacion
@dataclass
class FileInfoBook:
    """Registros de UN mes de UN dispositivo. El merge gana por `at`."""

    files: dict[str, dict] = field(default_factory=dict)
    version: int = VERSION

    def to_bytes(self) -> bytes:
        payload = {"version": self.version,
                   "files": {key: self.files[key] for key in sorted(self.files)}}
        return json.dumps(payload, sort_keys=True, ensure_ascii=False,
                          separators=(",", ":")).encode("utf-8")

    @classmethod
    def from_bytes(cls, data: bytes) -> "FileInfoBook":
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise FileInfoFormatError("fileinfo no es JSON valido") from exc
        if not isinstance(payload, dict):
            raise FileInfoFormatError("fileinfo no es un objeto JSON")
        if payload.get("version") != VERSION:
            raise FileInfoFormatError(
                f"version de fileinfo desconocida: {payload.get('version')!r}")
        files = payload.get("files")
        if not isinstance(files, dict):
            raise FileInfoFormatError("fileinfo no trae files")
        clean = {}
        for key, raw in files.items():
            record = clean_record(raw)
            if isinstance(key, str) and key and record:
                clean[key] = record
        return cls(files=clean)

    def merged(self, other: "FileInfoBook") -> "FileInfoBook":
        """Merge de dos libros: el `at` mas nuevo gana."""
        out = dict(self.files)
        for key, record in other.files.items():
            old = out.get(key)
            if old is None or record["at"] > old["at"]:
                out[key] = record
        return FileInfoBook(files=out)


# --------------------------------------------------------------- armado del registro
def _verdict_of(value: object) -> str:
    """Lo que el cliente repitio en `extra.match` es solo una pista."""
    return value if value in VERDICTS else "unknown"


def record_for_file(track, size: int, now: float) -> dict | None:
    """Registro de una descarga por `download_track` (archive, jamendo, wikimedia).

    El audio y la ficha vienen de la misma fuente. Solo archive.org lee los tags
    del audio; las otras fuentes nunca forman un veredicto.
    """
    source = track.source
    if source not in ("archive", "jamendo", "wikimedia"):
        return None
    extra = track.extra or {}
    verdict = "unknown"
    real = real_by = None
    score = None
    if source == "archive":
        origin = extra.get("title_source")
        verdict = _verdict_of(extra.get("match"))
        # Un titulo sacado del nombre del archivo no se leyo del audio.
        if origin in ("tags", "item-title"):
            real = extra.get("real_title")
            real_by = "tags" if origin == "tags" else "item"
        else:
            verdict = "unknown"
        score = extra.get("match_score")
    url = extra.get("item_url") if source == "archive" else (
        extra.get("shareurl") if source == "jamendo" else None)
    return clean_record({
        "verdict": verdict, "at": int(now), "bytes": size,
        "meta": source, "file": source, "meta_url": url, "file_url": url,
        "title": track.title, "artist": track.artist,
        "real": real, "real_by": real_by, "score": score,
    })


def record_for_ytdlp(track, size: int, now: float, *, query: str | None,
                     video_title: str | None, vacuous: bool) -> dict | None:
    """Registro de una descarga por yt-dlp (la ficha puede ser de iTunes).

    Se compara el titulo del VIDEO con lo que se busco: nunca se leyeron tags.
    `vacuous` = no hubo nada que comparar (un enlace pegado o sin consulta): el
    veredicto es `unknown` en vez de un "Coincide" que no dice nada.
    """
    extra = track.extra or {}
    from_itunes = bool(extra.get("from_itunes"))
    video = _text(video_title)
    video_url = extra.get("webpage_url")
    if vacuous or not video:
        verdict, score = "unknown", None
    else:
        score = round(similarity(query, video), 2)
        verdict = identify_verdict(query, video)[0]
    meta = "itunes" if from_itunes else "youtube"
    return clean_record({
        "verdict": verdict, "at": int(now), "bytes": size,
        "meta": meta, "file": "youtube",
        "meta_url": extra.get("item_url") if from_itunes else video_url,
        "file_url": video_url,
        "title": track.title, "artist": track.artist,
        "real": video, "real_by": "video" if video else None, "score": score,
    })


# --------------------------------------------------------------------- el join
def check_fields(record: dict | None, file: dict) -> dict:
    """Campos nuevos de una fila de `/api/library`. Vacio si no hay registro.

    Un registro cuyos `bytes` no son los del archivo describe OTRO contenido
    (se reemplazo bajo la misma clave): se ignora y el archivo queda "sin
    verificar" en vez de heredar un "Coincide" viejo.
    """
    if not record or record.get("bytes") != file.get("bytes"):
        return {}
    out = {"verdict": record["verdict"], "meta_src": record["meta"]}
    if record["file"] != record["meta"]:
        out["file_src"] = record["file"]
    if record["verdict"] in ("partial", "mismatch") and record.get("real"):
        out["real"] = record["real"]
    return out


def with_checks(files: list[dict], records: dict[str, dict]) -> list[dict]:
    """Copia de la lista con los campos del join. No toca los dicts de entrada."""
    if not records:
        return files
    out = []
    for item in files:
        extra = check_fields(records.get(item["key"]), item)
        out.append({**item, **extra} if extra else item)
    return out


# ---------------------------------------------------------------- flujo de archivos
class FileInfoStorageMixin:
    """Lectura-modificacion-escritura de `fileinfo-<device>-YYYY-MM.json`.

    Los adapters solo implementan los cuatro hooks de archivo. La lectura
    mergea TODOS los dispositivos y meses (gana el `at` mas nuevo) y la
    escritura toca unicamente el mes de ESTE dispositivo.
    """

    # ------------------------------------------------------------- hooks
    def _fileinfo_device(self) -> str:
        raise NotImplementedError

    def _fileinfo_list(self) -> list[tuple[str, str]]:
        """`(ref, name)` de los archivos `fileinfo-*`."""
        raise NotImplementedError

    def _fileinfo_read(self, ref: str) -> bytes:
        raise NotImplementedError

    def _fileinfo_write(self, name: str, data: bytes,
                        ref: str | None = None) -> str:
        """Crea (ref None) o reemplaza y devuelve la ref nueva."""
        raise NotImplementedError

    # ------------------------------------------------------------ internos
    def _fileinfo_lock(self) -> threading.RLock:
        lock = getattr(self, "_fileinfo_mutex", None)
        if lock is None:
            lock = threading.RLock()
            self._fileinfo_mutex = lock
        return lock

    def _fileinfo_now(self) -> float:
        return time.monotonic()

    def _read_own_fileinfo(self, ref: str | None) -> FileInfoBook:
        if ref is None:
            return FileInfoBook()
        try:
            return FileInfoBook.from_bytes(self._fileinfo_read(ref))
        except Exception as exc:  # red o formato: no se pisa a ciegas
            raise RuntimeError(
                "no se pudo leer el fileinfo propio: no se sobrescribe"
            ) from exc

    # -------------------------------------------------------------- publico
    def load_fileinfo(self) -> dict[str, dict]:
        """Registros de todos los dispositivos y meses, por clave."""
        with self._fileinfo_lock():
            cached = getattr(self, "_fileinfo_cache", None)
            if cached is not None and (
                    self._fileinfo_now() - cached[0]) < TTL:
                return dict(cached[1])
            merged = FileInfoBook()
            listing = [(ref, name) for ref, name in self._fileinfo_list()
                       if parse_fileinfo_file(name) is not None]
            # Se leen todos: la nube los baja en paralelo antes.
            warm = getattr(self, "_warm_small", None)
            if warm is not None:
                warm([ref for ref, _name in listing])
            for ref, name in listing:
                try:
                    book = FileInfoBook.from_bytes(self._fileinfo_read(ref))
                except Exception as exc:
                    log.warning("fileinfo ilegible %s: %s", name, exc)
                    continue
                merged = merged.merged(book)
            self._fileinfo_cache = (self._fileinfo_now(), dict(merged.files))
            return dict(merged.files)

    def save_fileinfo(self, key: str, record: dict) -> None:
        """Escribe el registro en el mes de ESTE dispositivo.

        Si el archivo propio de ese mes no se puede leer se levanta
        `RuntimeError`: escribir encima perderia lo que ya habia.
        """
        clean = clean_record(record)
        if not isinstance(key, str) or not key or clean is None:
            raise ValueError("registro de fileinfo invalido")
        device = self._fileinfo_device()
        name = fileinfo_file(device, month_of(clean["at"]))
        with self._fileinfo_lock():
            files = {file_name: ref
                     for ref, file_name in self._fileinfo_list()}
            ref = files.get(name)
            book = self._read_own_fileinfo(ref)
            old = book.files.get(key)
            if old is None or clean["at"] >= old["at"]:
                book.files[key] = clean
            self._fileinfo_write(name, book.to_bytes(), ref)
            cached = getattr(self, "_fileinfo_cache", None)
            if cached is not None:
                view = dict(cached[1])
                prev = view.get(key)
                if prev is None or clean["at"] >= prev["at"]:
                    view[key] = clean
                self._fileinfo_cache = (cached[0], view)
