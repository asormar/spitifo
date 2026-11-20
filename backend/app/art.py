"""Registro de imagenes personalizadas de temas, albumes y artistas (ADR 0005).

Igual que el registro de canciones guardadas (ADR 0004): es un libro chico por
dispositivo que los demas leen mergeado. Gana el `updated_at` mas nuevo y un
borrado deja un tombstone para que otra maquina no resucite la imagen vieja.

Los archivos de imagen NO viven en este libro: son content-addressed bajo
`.art/` (el sha256 de los bytes grandes da el nombre). Aca solo guardamos las
claves y la procedencia.

Los TARGETS son texto: `song:<id>` (id guardado o clave de biblioteca),
`album:<folded>` y `artist:<folded>`. El sufijo de album/artista es el id de
agrupacion que arma el frontend: minusculas, sin acentos ni caracteres de
control. Nunca una URL: las URLs vencen y ademas traerian `/` y `?`.

Modulo NEUTRAL y sin I/O, como `saved.py`: no importa starlette ni httpx y no
toca el disco. Los adapters de `storage` persisten el `ArtBook` y la API arma
y valida los bytes de las imagenes.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field, replace
from urllib.parse import urlsplit

from .saved import validate_song_id
from .storage import InvalidKey, validate_key

#: Version del formato. Un major distinto se rechaza en vez de adivinar.
VERSION = 1

#: Fuentes admitidas. `upload` es la unica que no baja bytes de una URL.
SOURCE_UPLOAD = "upload"
SOURCE_ITUNES = "itunes"
SOURCE_YOUTUBE = "youtube"
SOURCE_ARCHIVE = "archive"
SOURCES = frozenset({SOURCE_UPLOAD, SOURCE_ITUNES, SOURCE_YOUTUBE,
                     SOURCE_ARCHIVE})
SOURCES_URL = frozenset({SOURCE_ITUNES, SOURCE_YOUTUBE, SOURCE_ARCHIVE})

#: Carpeta oculta donde viven los JPG content-addressed. La `list()` de ambos
#: adapters salta los dot-dirs, asi que nunca aparecen como biblioteca.
ART_DIR = ".art"

#: Limites del cuerpo de la API (bytes YA decodificados de base64).
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_SMALL_BYTES = 300 * 1024
MAX_URL_LEN = 2000
JPEG_MAGIC = b"\xff\xd8\xff"

#: Tamano de las variantes que derivamos de una portada de mzstatic.
ITUNES_BIG_PX = 600
ITUNES_SMALL_PX = 120

MAX_TEXT_LEN = 300
_SONG = "song:"
_ALBUM = "album:"
_ARTIST = "artist:"
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_SIZE_TAIL = re.compile(r"/\d+x\d+bb\.jpg$")


class ArtFormatError(ValueError):
    """El `art-*.json` remoto no tiene el formato que se entiende."""


@dataclass(frozen=True)
class ArtRecord:
    """Imagen vigente (o tombstone) de un objetivo.

    `key` y `small_key` son las claves de Storage de los dos JPG. En un
    tombstone pueden estar vacias: el borrado viaja igual sin las imagenes, que
    se dejan en `.art/` (no hay garbage collection en este paso).
    """

    target: str
    key: str
    small_key: str
    source: str
    updated_at: float
    deleted: bool = False


def validate_target(target: object) -> str:
    """Valida un objetivo y lo devuelve tal cual. `ValueError` si no sirve."""
    if not isinstance(target, str) or not target:
        raise ValueError("destino invalido")
    if target.startswith(_SONG):
        raw = target[len(_SONG):]
        try:
            validate_song_id(raw)
        except ValueError:
            # Tambien vale una clave de un archivo de la biblioteca.
            try:
                validate_key(raw)
            except InvalidKey as exc:
                raise ValueError("destino invalido") from exc
        return target
    for prefix in (_ALBUM, _ARTIST):
        if target.startswith(prefix):
            raw = target[len(prefix):]
            if (not raw or len(raw) > MAX_TEXT_LEN
                    or _CONTROL.search(raw) or raw != raw.lower()):
                raise ValueError("destino invalido")
            return target
    raise ValueError("destino invalido")


def validate_source(source: object) -> str:
    """Una fuente conocida. `upload` no vale para `from-url`."""
    if source not in SOURCES:
        raise ValueError("fuente de imagen desconocida")
    return source


def validate_image(data: object, limit: int, field: str) -> bytes:
    """Bytes de un JPEG con magic y tamano correctos. `ValueError` si no."""
    if not isinstance(data, bytes):
        raise ValueError(f"{field} tiene que ser una imagen jpeg")
    if not data.startswith(JPEG_MAGIC):
        raise ValueError(f"{field} no es un jpeg")
    if len(data) > limit:
        raise ValueError(f"{field} es demasiado grande")
    return data


def _host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def _host_ok(source: str, host: str) -> bool:
    """Host permitido para esa fuente (subdominios solo donde aplica)."""
    if source == SOURCE_ITUNES:
        return host == "mzstatic.com" or host.endswith(".mzstatic.com")
    if source == SOURCE_YOUTUBE:
        return host == "i.ytimg.com"
    if source == SOURCE_ARCHIVE:
        return host == "archive.org" or host.endswith(".archive.org")
    return False


def validate_art_url(url: object, source: object) -> str:
    """https en un host de la lista, sin usuario, puerto raro ni query.

    `source` tiene que coincidir con el host: asi la procedencia que se guarda
    no miente sobre de donde salieron los bytes.
    """
    source = validate_source(source)
    if source not in SOURCES_URL:
        raise ValueError("esa fuente no permite bajar imagenes")
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LEN:
        raise ValueError("url de imagen invalida")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise ValueError("url de imagen invalida") from None
    if (parts.scheme != "https" or parts.username or parts.password
            or port not in (None, 443) or parts.query or parts.fragment):
        raise ValueError("url de imagen invalida")
    if not _host_ok(source, _host_of(url)):
        raise ValueError("host de imagen no permitido")
    return url


def mzstatic_variants(url: str) -> tuple[str, str] | None:
    """`(url_600, url_120)` de una portada de mzstatic, o None si no aplica.

    Misma idea que `covers.itunes_cover_urls`: el CDN reescala por URL, asi que
    no hace falta una libreria de imagenes (que en Android no existe).
    """
    try:
        validate_art_url(url, SOURCE_ITUNES)
    except ValueError:
        return None
    path = urlsplit(url).path
    if not _SIZE_TAIL.search(path):
        return None
    return (_SIZE_TAIL.sub(f"/{ITUNES_BIG_PX}x{ITUNES_BIG_PX}bb.jpg", url),
            _SIZE_TAIL.sub(f"/{ITUNES_SMALL_PX}x{ITUNES_SMALL_PX}bb.jpg", url))


def art_keys(digest: str) -> tuple[str, str]:
    """Claves de los dos JPG de un contenido dado su sha256 hex."""
    big = f"{ART_DIR}/{digest}.jpg"
    small = f"{ART_DIR}/{digest}.s.jpg"
    validate_key(big)
    validate_key(small)
    return big, small


def _is_number(value: object) -> bool:
    """`int`/`float` pero no `bool` (que es subclase de `int`)."""
    return not isinstance(value, bool) and isinstance(value, (int, float))


def _clean_record(raw: object, *, stored: bool) -> dict:
    """Valida un registro y devuelve sus campos limpios.

    `stored=True` exige ademas `updated_at` y `deleted` (el archivo en disco).
    En la API esos campos los pone el servidor. Levanta `ValueError` con un
    mensaje corto en castellano.
    """
    if not isinstance(raw, dict):
        raise ValueError("cada imagen tiene que ser un objeto")
    target = validate_target(raw.get("target"))
    source = validate_source(raw.get("source"))
    key, small = raw.get("key"), raw.get("small_key")
    deleted = raw.get("deleted", False) if stored else False
    if not isinstance(deleted, bool):
        raise ValueError("deleted tiene que ser booleano")
    if deleted:
        # Un tombstone no necesita las imagenes: pueden faltar en disco. Las
        # claves vacias son validas aca y tienen que sobrevivir al round trip,
        # si no el borrado no podria viajar a otra maquina.
        key = key or ""
        small = small or ""
    if key is None or small is None:
        raise ValueError("faltan las claves de la imagen")
    if not (deleted and key == "" and small == ""):
        try:
            validate_key(key)
            validate_key(small)
        except InvalidKey as exc:
            raise ValueError("clave de imagen invalida") from exc
    clean = {"target": target, "key": key, "small_key": small,
             "source": source}
    if stored:
        updated_at = raw.get("updated_at")
        if not _is_number(updated_at):
            raise ValueError("fecha de imagen invalida")
        clean["updated_at"] = float(updated_at)
        clean["deleted"] = deleted
    return clean


def _record_from_dict(raw: object) -> ArtRecord | None:
    """Imagen desde JSON. None si le falta algo o viene mal formada."""
    try:
        return ArtRecord(**_clean_record(raw, stored=True))
    except ValueError:
        return None


@dataclass
class ArtBook:
    """Las imagenes personalizadas de UN dispositivo. `records` va por target."""

    records: dict[str, ArtRecord] = field(default_factory=dict)
    version: int = VERSION

    def to_bytes(self) -> bytes:
        """JSON UTF-8 con claves ordenadas: bytes ESTABLES para comparar."""
        payload = {
            "version": self.version,
            "art": [asdict(self.records[k]) for k in sorted(self.records)],
        }
        return json.dumps(payload, sort_keys=True,
                          ensure_ascii=False).encode("utf-8")

    @classmethod
    def from_bytes(cls, data: bytes) -> ArtBook:
        """Reconstruye el libro. Rechaza un major desconocido; salta lo feo."""
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ArtFormatError("las imagenes no son JSON valido") from exc
        if not isinstance(payload, dict):
            raise ArtFormatError("las imagenes no son un objeto JSON")
        if payload.get("version") != VERSION:
            raise ArtFormatError(
                f"version de imagenes desconocida: {payload.get('version')!r}")
        book = cls()
        for raw in payload.get("art", []):
            record = _record_from_dict(raw)
            if record is not None:
                book.records[record.target] = record
        return book

    def upsert(self, record: ArtRecord) -> None:
        self.records[validate_target(record.target)] = record

    def remove(self, target: str, now: float) -> None:
        """Escribe un tombstone con el `updated_at` nuevo."""
        target = validate_target(target)
        current = self.records.get(target)
        if current is None:
            self.records[target] = ArtRecord(
                target=target, key="", small_key="", source=SOURCE_UPLOAD,
                updated_at=now, deleted=True)
        else:
            self.records[target] = replace(current, deleted=True,
                                           updated_at=now)

    def live(self) -> list[ArtRecord]:
        """Las imagenes vigentes, de la mas reciente a la mas vieja."""
        vivas = [r for r in self.records.values() if not r.deleted]
        return sorted(vivas, key=lambda r: (-r.updated_at, r.target))

    def merge(self, other: ArtBook) -> ArtBook:
        """Por target gana el `updated_at` mas nuevo. En empate, el tombstone."""
        merged = ArtBook(records=dict(self.records))
        for target, record in other.records.items():
            mine = merged.records.get(target)
            if mine is None or record.updated_at > mine.updated_at:
                merged.records[target] = record
            elif (record.updated_at == mine.updated_at
                  and record.deleted and not mine.deleted):
                merged.records[target] = record
        return merged
