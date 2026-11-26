"""Spitifo API — buscar y descargar musica (fuentes libres + yt-dlp opcional).

Starlette puro, sin FastAPI ni pydantic: el backend tiene que poder correr
embebido en Android (Chaquopy) y pydantic-core no tiene build para esa
plataforma (ver docs/adr/0001-android-embedded-python.md). Las rutas, los
parametros y las respuestas son los mismos que devolvia la version FastAPI.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import mimetypes
import os
import re
import shutil
import tempfile
import threading
import time
from collections import deque
import weakref
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import activity, downloads, lyrics, ytdlp_update
from .config import AUDIO_EXTS, IMAGE_EXTS, USER_AGENT, VIDEO_EXTS
from .executors import run_prefetch, run_storage
from .runtime import configure_runtime, start_ytdlp_zip_check, ytdlp_version

# ANTES de importar el motor: fija el PATH de ffmpeg (SPITIFO_FFMPEG_DIR) y los
# MIME de audio que Android no trae, para que esten listos cuando algo llame a
# shutil.which o sirva un archivo.
configure_runtime()

from .artistinfo import Enricher, fold, library_artists
from .art import (
    ART_DIR,
    MAX_IMAGE_BYTES,
    MAX_SMALL_BYTES,
    SOURCE_ITUNES,
    SOURCE_UPLOAD,
    ArtRecord,
    art_keys,
    mzstatic_variants,
    validate_art_url,
    validate_image,
    validate_source,
    validate_target,
)
from .downloader import (
    _thumb_sidecar,
    download_track,
    library_scan,
    thumb_small_sidecar,
)
from .fileinfo import with_checks
from .listens import validate_events
from .models import Track
from .playlists import Playlist, validate_playlist
from .saved import (MAX_SONGS, SavedBook, SavedSong, song_id_for_track,
                    validate_saved_payload, validate_song_id)
from .security import TokenAuthMiddleware
from .sources import ALL_SOURCES, BY_NAME, search_all, _register_ytdlp
from .storage import InvalidKey, get_storage, reset_storage, validate_key
from .suggest import suggestions_from_raw

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("spitifo")

# El frontend compilado vive en su ubicacion habitual dentro del repo.
# SPITIFO_FRONTEND_DIST permite apuntar a otro dist: hace falta cuando el
# backend corre embebido y los estaticos NO estan en el arbol del repo.
FRONTEND_DIST = Path(os.getenv(
    "SPITIFO_FRONTEND_DIST",
    Path(__file__).resolve().parents[2] / "frontend" / "dist"))

# tasks asyncio en vuelo (descargas ytdlp en background), para que Python
# no las recolecte a mitad de camino
BG_TASKS: set = set()

# Cache del match de albumes: {album_id: (timestamp, respuesta)}. Media hora y
# ~50 albumes: abrir el mismo album dos veces no vuelve a buscar en YouTube.
_ALBUM_MATCH_CACHE: dict = {}
_ALBUM_MATCH_TTL_S = 30 * 60
_ALBUM_MATCH_MAX = 50
_ALBUM_MATCH_SEMAPHORE = 3   # busquedas puntuales simultaneas por pista
_ALBUM_TRACK_LIMIT = 8       # candidatos por busqueda puntual de una pista

# Busquedas sueltas de /api/search y de la ruta lazy: comparten un solo limite
# (el album sigue con el suyo de 3).
_SEARCH_SINGLE_SEMAPHORE = 6
# Uno por event loop: un Semaphore queda atado al loop donde espera por
# primera vez, y los tests (y un reinicio del servidor) cambian de loop.
_SEARCH_SINGLE_SEMS: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


def _search_single_sem() -> asyncio.Semaphore:
    """El limite compartido de busquedas sueltas del loop actual."""
    loop = asyncio.get_running_loop()
    sem = _SEARCH_SINGLE_SEMS.get(loop)
    if sem is None:
        sem = _SEARCH_SINGLE_SEMS[loop] = asyncio.Semaphore(_SEARCH_SINGLE_SEMAPHORE)
    return sem

# Cache de matches sueltos: {trackId: (timestamp, match, acierto)}. Los aciertos
# viven media hora; los fallos solo diez minutos para no repetir la busqueda en
# cada scroll. Expulsion por antiguedad, como la cache de albumes.
_TRACK_MATCH_CACHE: dict = {}
_TRACK_MATCH_HIT_TTL_S = 30 * 60
_TRACK_MATCH_MISS_TTL_S = 10 * 60
_TRACK_MATCH_MAX = 2000

# Dicts crudos de iTunes por busqueda, para que la ruta lazy sepa que pista
# buscar sin volver a iTunes. Media hora y tope, igual que el match de albumes.
_TRACK_RAW_CACHE: dict = {}
_TRACK_RAW_TTL_S = 30 * 60
_TRACK_RAW_MAX = 1000

# Candidatos crudos de YouTube por consulta+limite normalizados. La busqueda
# grupal de modo Musica es el paso mas caro (un ytsearch40); una consulta
# repetida no vuelve a pedirla. TTL mas corto que el de los matches: los resultados de
# YouTube cambian mas seguido que "hay o no hay version entera".
_YT_CANDIDATES_CACHE: dict = {}
_YT_CANDIDATES_TTL_S = 5 * 60
_YT_CANDIDATES_MAX = 32
#: Candidatos de la busqueda grupal de modo Musica (mismo numero de siempre).
_GROUP_SEARCH_LIMIT = 40


def _candidates_cache_key(q: str, limit: int) -> str:
    return f"{' '.join((q or '').split()).casefold()}::{limit}"


def _candidates_cache_get(q: str, limit: int) -> list[dict] | None:
    clave = _candidates_cache_key(q, limit)
    hit = _YT_CANDIDATES_CACHE.get(clave)
    if not hit:
        return None
    guardado, candidatos = hit
    if _breaker_clock() - guardado >= _YT_CANDIDATES_TTL_S:
        _YT_CANDIDATES_CACHE.pop(clave, None)
        return None
    return candidatos


def _candidates_cache_put(q: str, limit: int, candidatos: list[dict]) -> None:
    clave = _candidates_cache_key(q, limit)
    _YT_CANDIDATES_CACHE[clave] = (_breaker_clock(), candidatos)
    if len(_YT_CANDIDATES_CACHE) > _YT_CANDIDATES_MAX:
        vieja = min(_YT_CANDIDATES_CACHE, key=lambda k: _YT_CANDIDATES_CACHE[k][0])
        _YT_CANDIDATES_CACHE.pop(vieja, None)


async def _search_candidates_cached(ysrc, q: str, limit: int) -> list[dict]:
    """`ysrc.search_candidates` con una cache acotada por consulta+limite."""
    cached = _candidates_cache_get(q, limit)
    if cached is not None:
        return cached
    candidatos = await ysrc.search_candidates(q, limit=limit)
    _candidates_cache_put(q, limit, candidatos)
    return candidatos

# Circuito de YouTube: un muro de verificacion o un 429 pausa las busquedas
# sueltas cinco minutos. Reloj inyectable para poder moverlo en los tests.
_YT_BREAKER_SECONDS = 5 * 60
_YT_BREAKER_OPENED_AT: float | None = None
_breaker_clock = time.monotonic
_RATE_LIMIT_RE = re.compile(
    r"\b429\b|too many requests|rate.limit|try again later|retry later",
    re.IGNORECASE)


def _breaker_reset() -> None:
    """Cierra el circuito (lo usa el arranque limpio de cada test)."""
    global _YT_BREAKER_OPENED_AT
    _YT_BREAKER_OPENED_AT = None


def _breaker_abierto() -> bool:
    """True mientras el circuito este abierto; se cierra solo al vencer el TTL."""
    global _YT_BREAKER_OPENED_AT
    if _YT_BREAKER_OPENED_AT is None:
        return False
    if _breaker_clock() - _YT_BREAKER_OPENED_AT >= _YT_BREAKER_SECONDS:
        _YT_BREAKER_OPENED_AT = None
        return False
    return True


def _breaker_abrir() -> None:
    """Abre el circuito una vez y avisa en el log, sin spam por cada pista."""
    global _YT_BREAKER_OPENED_AT
    if _YT_BREAKER_OPENED_AT is None:
        log.warning("YouTube muro/rate limit: busquedas sueltas pausadas %ds",
                    _YT_BREAKER_SECONDS)
    _YT_BREAKER_OPENED_AT = _breaker_clock()


def _es_error_de_youtube_ocupado(error) -> bool:
    """Bot wall o rate limit: merece pausar las busquedas sueltas."""
    from .ytdlp_source import is_bot_check_error
    return is_bot_check_error(error) or bool(_RATE_LIMIT_RE.search(str(error)))


class _YtConCircuito:
    """Envuelve la fuente yt-dlp y abre el circuito en bot wall / rate limit.

    Asi el matcher sigue recibiendo una fuente normal: no hay que cambiar su
    firma y los dobles de los tests siguen funcionando.
    """

    def __init__(self, real):
        self._real = real

    def available(self) -> bool:
        return self._real.available()

    async def search_candidates(self, q, limit=40):
        try:
            return await self._real.search_candidates(q, limit)
        except Exception as e:
            if _es_error_de_youtube_ocupado(e):
                _breaker_abrir()
            raise


def _track_match_cache_get(track_id: str) -> tuple[dict, bool] | None:
    """(match, acierto) cacheado, o None. Aciertos y fallos tienen distinto TTL."""
    hit = _TRACK_MATCH_CACHE.get(track_id)
    if not hit:
        return None
    guardado, match, acierto = hit
    ttl = _TRACK_MATCH_HIT_TTL_S if acierto else _TRACK_MATCH_MISS_TTL_S
    if _breaker_clock() - guardado >= ttl:
        _TRACK_MATCH_CACHE.pop(track_id, None)
        return None
    return match, acierto


def _track_match_cache_put(track_id: str, match: dict) -> None:
    """Guarda un match suelto con expulsion por antiguedad."""
    match = match or {}
    acierto = bool(match.get("video"))
    _TRACK_MATCH_CACHE[track_id] = (_breaker_clock(), match, acierto)
    if len(_TRACK_MATCH_CACHE) > _TRACK_MATCH_MAX:
        vieja = min(_TRACK_MATCH_CACHE, key=lambda k: _TRACK_MATCH_CACHE[k][0])
        _TRACK_MATCH_CACHE.pop(vieja, None)


def _track_match_cache_put_muchos(matched: dict) -> None:
    """Llena la cache con los ACIERTOS de una busqueda grupal.

    Un fallo grupal no es un fallo definitivo: significa que el video no estaba
    entre esos candidatos, y por eso se busca la pista suelta despues. Solo se
    cachean los fallos de una busqueda puntual (que si completo la busqueda).
    """
    for clave, match in matched.items():
        if (match or {}).get("video"):
            _track_match_cache_put(clave, match)


def _track_raw_put(raws: list[dict]) -> None:
    """Recuerda los dicts crudos de una busqueda por su trackId."""
    ahora = _breaker_clock()
    for raw in raws:
        track_id = str(raw.get("trackId") or "")
        if track_id:
            _TRACK_RAW_CACHE[track_id] = (ahora, raw)
    if len(_TRACK_RAW_CACHE) > _TRACK_RAW_MAX:
        vieja = min(_TRACK_RAW_CACHE, key=lambda k: _TRACK_RAW_CACHE[k][0])
        _TRACK_RAW_CACHE.pop(vieja, None)


def _track_raw_get(track_id: str) -> dict | None:
    """Dict crudo cacheado, o None si no existe o vencio."""
    hit = _TRACK_RAW_CACHE.get(track_id)
    if not hit:
        return None
    guardado, raw = hit
    if _breaker_clock() - guardado >= _TRACK_RAW_TTL_S:
        _TRACK_RAW_CACHE.pop(track_id, None)
        return None
    return raw

# Cache del top de artistas: {artist_id: (timestamp, respuesta)}. El match en
# YouTube tarda, asi que la pagina lo pide aparte y aqui se reutiliza. Media
# hora y ~50 artistas, igual que el match de albumes.
_ARTIST_TOP_CACHE: dict = {}
_ARTIST_TOP_TTL_S = 30 * 60
_ARTIST_TOP_MAX = 50
TOP_SONGS_LIMIT = 5
# Un lock por id (y por loop, como el guardado de portadas): dos pedidos frios
# del mismo artista comparten un solo lookup de iTunes y una sola busqueda en
# YouTube. Se crea perezoso y el WeakKeyDictionary no retiene loops muertos.
_ARTIST_TOP_LOCKS: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, asyncio.Lock]]" = (
    weakref.WeakKeyDictionary())


def _top_lock(artista_id: str) -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    por_id = _ARTIST_TOP_LOCKS.get(loop)
    if por_id is None:
        por_id = _ARTIST_TOP_LOCKS[loop] = {}
    lock = por_id.get(artista_id)
    if lock is None:
        lock = por_id[artista_id] = asyncio.Lock()
    return lock
# Se piden mas canciones a iTunes porque dedupe antes del tope: dos versiones
# del mismo tema (p. ej. "Creep" y "Creep (Remastered)") no pueden quitarle
# una plaza a una cancion distinta.
ITUNES_TOP_LOOKUP_LIMIT = 10


#: Espera antes de preparar la busqueda de YouTube: importar yt-dlp es CPU
#: pura y no debe competir con la primera pantalla.
PREWARM_DELAY_S = 4.0


async def _prewarm_search() -> None:
    try:
        await asyncio.sleep(PREWARM_DELAY_S)
        from .executors import run_ytdlp
        from .ytdlp_source import prewarm_search
        await run_ytdlp(prewarm_search)
    except Exception as e:
        log.info("ytdlp: preparacion de la busqueda fallo: %s", e)


async def _recover_queue_and_cleanup() -> None:
    """Recupera la cola y limpia temporales viejos, SIN demorar `SPITIFO_READY`.

    Las dos cosas son disco (leer+parsear el JSON de la cola, recorrer
    TEMP_DIR y borrar carpetas viejas): antes corrian sincronicas en el
    lifespan, asi que un server con muchas carpetas parciales abandonadas (o
    una cola grande) tardaba ese rato extra en imprimir el READY que el shell
    nativo (Tauri/Chaquopy) espera para considerar la app usable. Ninguna de
    las dos es parte del camino critico de arranque: la UI puede pintar la
    biblioteca mientras esto termina atras.
    """
    try:
        await downloads.load_async()
    except Exception as e:
        log.warning("no se pudo recuperar la cola de descargas: %s", e)
    from .ytdlp_source import cleanup_partials
    try:
        await asyncio.to_thread(cleanup_partials)
    except Exception as e:
        log.warning("no se pudieron limpiar las carpetas parciales viejas: %s", e)


@asynccontextmanager
async def lifespan(app: Starlette):
    _register_ytdlp()  # registrar al arrancar para que /api/download la encuentre
    tarea = asyncio.create_task(_recover_queue_and_cleanup())
    BG_TASKS.add(tarea)
    tarea.add_done_callback(BG_TASKS.discard)
    # El zip de yt-dlp actualizado se prueba ya servido, no antes: importarlo
    # tarda alrededor de un segundo.
    start_ytdlp_zip_check()
    # Chequeo de yt-dlp en segundo plano: si hay una version mas nueva en GitHub
    # la deja lista para el proximo arranque (no reemplaza la ya importada).
    ytdlp_update.start_background_check()
    # El visitor_data del streaming se busca al arrancar, nunca en el primer
    # play: si falla, el camino rapido cae al completo y el usuario no lo nota.
    if any(s.name == "ytdlp" and s.available() for s in ALL_SOURCES):
        from .ytdlp_source import ensure_yt_dlp_imported
        # El import de yt_dlp arranca YA, en un hilo: es CPU/disco puro y no
        # compite por la conexion a youtube.com, asi que no espera los 4 s del
        # prewarm de red (ese retraso es solo para no competir con la primera
        # pantalla con trafico).
        tarea = asyncio.ensure_future(ensure_yt_dlp_imported())
        BG_TASKS.add(tarea)
        tarea.add_done_callback(BG_TASKS.discard)
        from . import stream as stream_mod
        for coro in (stream_mod.warm_visitor(), _prewarm_search()):
            tarea = asyncio.create_task(coro)
            BG_TASKS.add(tarea)
            tarea.add_done_callback(BG_TASKS.discard)
    storage = get_storage()
    log.info("biblioteca: %s", storage.describe())
    log.info("fuentes activas: %s",
             [s.name for s in ALL_SOURCES if s.available()])
    # Un solo `files.list` para TODOS los registros chicos (indice, playlists,
    # guardadas, imagenes, escuchas, artistinfo, descartes, fileinfo) en vez
    # de uno por cada uno al primer pedido de cada pantalla (P-drive-io-4).
    # Sin red (disco local, o la nube caida) no es grave: cada registro cae
    # a listar el suyo, como siempre.
    # En segundo plano: el arranque nunca espera a la red (sin conexion, el
    # listado podria tardar el timeout entero antes de SPITIFO_READY).
    warm = getattr(storage, "warm_small_files", None)
    if warm is not None:
        async def _warm_small_files() -> None:
            try:
                await asyncio.to_thread(warm)
            except Exception as exc:
                log.info("no se pudo precalentar los archivos chicos: %s", exc)
        tarea = asyncio.create_task(_warm_small_files())
        BG_TASKS.add(tarea)
        tarea.add_done_callback(BG_TASKS.discard)
    yield
    for s in ALL_SOURCES:
        await s.aclose()
    from . import stream as stream_mod
    await stream_mod.aclose()
    from . import covers, identify
    await identify.aclose()
    await covers.aclose()
    # Cualquier cambio del indice que haya quedado diferido (dentro de un
    # `batch_index_writes` que no llego a cerrar su bloque) se sube ahora.
    flush_all = getattr(storage, "flush_all", None)
    if flush_all is not None:
        try:
            await asyncio.to_thread(flush_all)
        except Exception as exc:
            log.warning("no se pudo terminar de subir el indice al cerrar: %s",
                       exc)


# --------------------------------------------------------------- validacion
# Reemplazo directo de lo que hacian fastapi.Query y los modelos pydantic:
# mismos limites, mismos defaults y mismo cuerpo de error ({"detail": [...]})
# que el frontend ya conoce.


def _invalid(loc: list, msg: str) -> HTTPException:
    """422 con el detalle en el mismo formato que devolvia FastAPI/pydantic."""
    return HTTPException(422, [{"type": "value_error", "loc": loc, "msg": msg}])


def _query_str(request: Request, name: str, *, required: bool = False,
               default=None, min_length: int | None = None,
               max_length: int | None = None):
    v = request.query_params.get(name)
    if v is None:
        if required:
            raise _invalid(["query", name], "Field required")
        return default
    if min_length is not None and len(v) < min_length:
        raise _invalid(["query", name],
                       f"String should have at least {min_length} characters")
    if max_length is not None and len(v) > max_length:
        raise _invalid(["query", name],
                       f"String should have at most {max_length} characters")
    return v


def _query_int(request: Request, name: str, default: int, ge: int, le: int) -> int:
    v = request.query_params.get(name)
    if v is None:
        return default
    try:
        n = int(v)
    except ValueError:
        raise _invalid(["query", name], "Input should be a valid integer")
    if n < ge or n > le:
        raise _invalid(["query", name], f"Input should be between {ge} and {le}")
    return n


def _query_int_or_none(request: Request, name: str, *, ge: int, le: int) -> int | None:
    v = request.query_params.get(name)
    if v is None:
        return None
    try:
        n = int(v)
    except ValueError:
        raise _invalid(["query", name], "Input should be a valid integer")
    if n < ge or n > le:
        raise _invalid(["query", name], f"Input should be between {ge} and {le}")
    return n


def _query_list(request: Request, name: str, *, max_items: int,
                max_length: int) -> list[str]:
    items = request.query_params.getlist(name)
    if len(items) > max_items:
        raise _invalid(["query", name], f"At most {max_items} items")
    for v in items:
        if len(v) > max_length:
            raise _invalid(["query", name],
                           f"String should have at most {max_length} characters")
    return items


def _query_bool(request: Request, name: str, default: bool) -> bool:
    v = request.query_params.get(name)
    if v is None:
        return default
    s = v.strip().lower()
    if s in ("1", "true", "t", "yes", "y", "on"):
        return True
    if s in ("0", "false", "f", "no", "n", "off"):
        return False
    raise _invalid(["query", name], "Input should be a valid boolean")


async def _json_body(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        raise _invalid(["body"], "JSON decode error")
    if not isinstance(body, dict):
        raise _invalid(["body"], "Input should be a valid dictionary")
    return body


#: Valores validos de `media`. El default ("audio") es el comportamiento de
#: siempre; "video" y "both" bajan video de YouTube (solo en el camino yt-dlp).
_MEDIA_CHOICES = ("audio", "video", "both")


#: Limites de `height` (px): las resoluciones reales van de 144p a 8K.
_MIN_HEIGHT, _MAX_HEIGHT = 144, 4320


def _height_field(body: dict, media: str) -> int | None:
    """Valida `height` (144..4320) y lo ignora cuando media es audio.

    Acepta `int` y un `float` entero (modo laxo, como el resto de la API), pero
    NUNCA un `bool`: `True` no es "1080". Ausente o `null` = mejor disponible.
    """
    if "height" not in body or body["height"] is None:
        return None
    v = body["height"]
    entero = ((isinstance(v, int) and not isinstance(v, bool))
              or (isinstance(v, float) and v.is_integer()))
    if not entero:
        raise _invalid(["body", "height"], "Input should be a valid integer")
    v = int(v)
    if v < _MIN_HEIGHT or v > _MAX_HEIGHT:
        raise _invalid(["body", "height"],
                       f"Input should be between {_MIN_HEIGHT} and {_MAX_HEIGHT}")
    # El audio no tiene resolucion: se ignora (no cambia la descarga).
    return v if media in ("video", "both") else None


@dataclass
class DownloadReq:
    source: str
    track: dict
    fmt: str = "original"  # original | mp3 | m4a
    media: str = "audio"  # audio | video | both (solo en el camino yt-dlp)
    height: int | None = None  # altura elegida (solo video/both)

    @classmethod
    def from_body(cls, body: dict) -> "DownloadReq":
        """Valida el cuerpo de /api/download (antes lo hacia pydantic)."""
        src = body.get("source")
        if not isinstance(src, str):
            raise _invalid(["body", "source"],
                           "Field required" if "source" not in body
                           else "Input should be a valid string")
        track = body.get("track")
        if not isinstance(track, dict):
            raise _invalid(["body", "track"],
                           "Field required" if "track" not in body
                           else "Input should be a valid dictionary")
        fmt = body.get("fmt", "original")
        if not isinstance(fmt, str):
            raise _invalid(["body", "fmt"], "Input should be a valid string")
        media = body.get("media", "audio")
        if not isinstance(media, str):
            raise _invalid(["body", "media"], "Input should be a valid string")
        if media not in _MEDIA_CHOICES:
            esperado = " or ".join(repr(c) for c in _MEDIA_CHOICES)
            raise _invalid(["body", "media"], f"Input should be {esperado}")
        height = _height_field(body, media)
        return cls(source=src, track=track, fmt=fmt, media=media, height=height)


# TrackPayload: nombre de campo -> (tipo, obligatorio). El orden es el mismo
# del modelo pydantic original.
_TRACK_FIELDS = {
    "source": (str, True), "source_id": (str, True), "title": (str, True),
    "artist": (str, True), "album": (str, False), "duration_s": (int, False),
    "artwork_url": (str, False), "audio_url": (str, False),
    "preview_url": (str, False), "license": (str, False), "year": (str, False),
    "extra": (dict, False), "real_title": (str, False),
    "real_artist": (str, False), "match": (str, False),
    "match_label": (str, False), "item_url": (str, False),
    "filename": (str, False), "format": (str, False), "size_mb": (float, False),
}


def _coerce(name: str, typ: type, v, loc: list):
    """Convierte/valida un valor como lo hacia pydantic (modo laxo)."""
    if typ is str:
        ok = isinstance(v, str)
    elif typ is int:
        ok = (isinstance(v, int) and not isinstance(v, bool)) or (
            isinstance(v, float) and v.is_integer())
        if ok:
            v = int(v)
    elif typ is float:
        ok = isinstance(v, (int, float)) and not isinstance(v, bool)
        if ok:
            v = float(v)
    else:
        ok = isinstance(v, dict)
    if not ok:
        raise _invalid(loc + [name], f"Input should be a valid {typ.__name__}")
    return v


@dataclass
class TrackPayload:
    source: str
    source_id: str
    title: str
    artist: str
    album: str | None = None
    duration_s: int | None = None
    artwork_url: str | None = None
    audio_url: str | None = None
    preview_url: str | None = None
    license: str | None = None
    year: str | None = None
    extra: dict = field(default_factory=dict)
    # campos que devuelve /api/setlist en la raiz (ver to_track)
    real_title: str | None = None
    real_artist: str | None = None
    match: str | None = None
    match_label: str | None = None
    item_url: str | None = None
    filename: str | None = None
    format: str | None = None
    size_mb: float | None = None

    @classmethod
    def from_dict(cls, data: dict, loc: list) -> "TrackPayload":
        """Valida un dict crudo del body (antes: TrackPayload(**data))."""
        out: dict = {}
        for name, (typ, required) in _TRACK_FIELDS.items():
            if name not in data:
                if required:
                    raise _invalid(loc + [name], "Field required")
                out[name] = {} if name == "extra" else None
                continue
            v = data[name]
            if v is None and not required:
                out[name] = {} if name == "extra" else None
                continue
            out[name] = _coerce(name, typ, v, loc)
        return cls(**out)

    @classmethod
    def from_track(cls, t: Track) -> "TrackPayload":
        d = t.to_dict()
        d.pop("downloadable", None)  # derivado, no es campo del payload
        return cls(**d)

    def to_track(self) -> Track:
        d = asdict(self)
        # /api/setlist devuelve la identidad verificada en la RAIZ (real_title,
        # real_artist, match); downloader.py la lee de extra. Normalizar aca.
        extra = dict(d.get("extra") or {})
        for k in ("real_title", "real_artist", "match", "match_label",
                  "item_url", "filename", "format", "size_mb"):
            if k in d and k not in extra and d[k] is not None:
                extra[k] = d[k]
        d["extra"] = extra
        # quitar campos que no son del dataclass Track
        for k in ("real_title", "real_artist", "match", "match_label",
                  "item_url", "filename", "format", "size_mb"):
            d.pop(k, None)
        return Track(**d)


# -------------------------------------------------------------------- rutas
async def health(request: Request):
    _register_ytdlp()  # mostrar yt-dlp en health si esta habilitada
    # Runtime de JS de yt-dlp: "quickjs" solo si SPITIFO_QJS apunta a un
    # archivo que existe; sin eso queda el default de yt-dlp (null).
    from .ytdlp_source import configured_js_runtime
    return JSONResponse({
        "ok": True,
        "sources": [
            {"name": s.name, "active": s.available(),
             "needs_key": s.needs_key}
            for s in ALL_SOURCES
        ],
        "library": get_storage().describe(),
        # None si yt-dlp no se puede importar. El primer import es lento: va a
        # un thread para no frenar el event loop.
        "ytdlp_version": await asyncio.to_thread(ytdlp_version),
        # Version ya bajada que todavia no es la cargada (se aplica al reiniciar).
        "ytdlp_pending": await asyncio.to_thread(ytdlp_update.pending_version),
        "js_runtime": configured_js_runtime(),
    })


async def search(request: Request):
    q = _query_str(request, "q", required=True, min_length=1, max_length=200)
    limit = _query_int(request, "limit", 20, 1, 50)
    source = _query_str(request, "source", default=None)
    mode = _query_str(request, "mode", default="matched")

    # ---- modo "matched": iTunes es el catalogo, yt-dlp la descarga ----
    if mode == "matched" and not source:
        if _query_str(request, "stream", default=None) in ("1", "true", "yes"):
            eventos = _search_matched_eventos(q, limit, stream=True)
            # El catalogo se saca antes de abrir el stream: si iTunes falla,
            # aca todavia se puede devolver un error HTTP normal.
            try:
                primero = await eventos.__anext__()
            except StopAsyncIteration:
                primero = ("done", {"full": 0, "count": 0})
            return _match_stream_response(
                eventos, primero, done_keys=("full", "count"))
        return JSONResponse(await _search_matched(q, limit))

    sources = [source] if source else None
    if source and source not in BY_NAME:
        raise HTTPException(400, f"fuente desconocida: {source}")
    try:
        tracks = await search_all(q, limit, sources)
    except Exception as e:
        log.exception("search fallo")
        raise HTTPException(502, f"error buscando: {e}")

    for t in tracks:
        t.extra["needs_resolve"] = (
            t.source in ("archive", "ytdlp") and not t.audio_url)
    tracks = _group_shows(tracks)
    tracks.sort(key=lambda t: 0 if t.downloadable or t.extra.get("needs_resolve") else 1)

    return JSONResponse({
        "query": q, "mode": mode, "count": len(tracks),
        "results": [t.to_dict() for t in tracks],
    })


#: iTunes acepta unas 20 busquedas por minuto por IP: las sugerencias (una por
#: pausa al escribir) no pueden gastarse ese cupo y dejar sin resultados a la
#: busqueda de verdad. Pasado el tope, la respuesta va vacia y el frontend
#: sigue con las sugerencias de la biblioteca.
_SUGGEST_MAX_PER_MIN = 8
_SUGGEST_CALLS: deque = deque()


def _suggest_allowed() -> bool:
    ahora = time.monotonic()
    while _SUGGEST_CALLS and ahora - _SUGGEST_CALLS[0] > 60:
        _SUGGEST_CALLS.popleft()
    if len(_SUGGEST_CALLS) >= _SUGGEST_MAX_PER_MIN:
        return False
    _SUGGEST_CALLS.append(ahora)
    return True


async def search_suggest(request: Request):
    """GET /api/search/suggest: sugerencias baratas mientras se escribe.

    Una sola llamada a iTunes, sin YouTube y sin el stream de Buscar. Un fallo
    de iTunes deja la lista vacia: escribir nunca debe convertirse en un error.
    """
    q = _query_str(request, "q", required=True, min_length=2, max_length=200)
    limit = _query_int(request, "limit", 6, 1, 12)
    if not _suggest_allowed():
        return JSONResponse({"query": q, "suggestions": [], "throttled": True})
    try:
        raws = await BY_NAME["itunes"]._raw_search(q, limit=limit * 2)
    except Exception as e:
        log.warning("suggest search fallo: %s", e)
        raws = []
    return JSONResponse({"query": q, "suggestions": suggestions_from_raw(raws, limit)})


async def search_match(request: Request):
    """GET /api/search/match/{track_id}: match suelto de una fila `lazy`.

    La ficha cruda sale de la cache de la busqueda; si expiro o el proceso
    arranco de nuevo, se pide a iTunes por trackId. Con el circuito de YouTube
    abierto no se busca: se devuelve 503 con codigo `youtube_busy`.
    """
    track_id = str(request.path_params["track_id"])
    if not track_id.isdigit():
        raise _invalid(["path", "id"], "Input should be a valid integer")
    priority = _query_bool(request, "priority", False)

    raw = _track_raw_get(track_id)
    if raw is None:
        try:
            raw = await BY_NAME["itunes"].lookup_track(track_id)
        except Exception as e:
            log.warning("lookup de pista fallo: %s", e)
            raise HTTPException(502, "iTunes no respondio") from e
    if raw is None:
        raise HTTPException(404, "pista no encontrada")

    _register_ytdlp()
    ysrc = BY_NAME.get("ytdlp")
    yt_on = bool(ysrc and ysrc.available())
    # Lo cacheado se sirve aunque el circuito este abierto: no toca YouTube.
    if (yt_on and _track_match_cache_get(_track_key(raw)) is None
            and _breaker_abierto()):
        return JSONResponse({"detail": "YouTube ocupado, reintente en unos minutos",
                             "code": "youtube_busy"}, status_code=503)

    match = {}
    if yt_on:
        res = await _buscar_pista_suelta(
            raw, ysrc, priority=priority,
            sem=None if priority else _search_single_sem())
        match = res.get(_track_key(raw), {})
    track = _itunes_track(raw, match)
    track.extra["match_state"] = (
        "full" if (match or {}).get("video") else "none")
    return JSONResponse({"track": track.to_dict()})


async def lyrics_route(request: Request):
    """GET /api/lyrics -> letra sincronizada via LRCLIB, nunca rompe la pagina.

    200 con nulls si LRCLIB no tiene la cancion, y 200 con nulls mas
    `error: "unavailable"` si la red fallo: la UI decide cuando mostrar
    "Letra no disponible ahora", nunca un error HTTP.
    """
    title = _query_str(request, "title", required=True, min_length=1, max_length=200)
    artist = _query_str(request, "artist", required=True, min_length=1, max_length=200)
    album = _query_str(request, "album", default=None, max_length=200)
    duration = _query_int_or_none(request, "duration", ge=0, le=36000)
    alt_titles = _query_list(request, "alt_title", max_items=5, max_length=200)
    alt_artists = _query_list(request, "alt_artist", max_items=5, max_length=200)

    resultado = await lyrics.get_lyrics(
        title=title, artist=artist, album=album, duration=duration,
        alt_titles=alt_titles, alt_artists=alt_artists)
    return JSONResponse(resultado)


# ------------------------------------------------------------------- albumes
# Los dicts crudos de iTunes traen collectionId/trackNumber/discNumber (y sus
# totales) en CADA pista; el buscador de antes los descartaba. Una sola fabrica
# de Track para /api/search y para las rutas de album, asi el downloader recibe
# siempre los mismos campos en `extra`.


def _track_key(raw: dict) -> str:
    return str(raw.get("trackId") or raw.get("collectionId") or
               raw.get("trackName", ""))


def _int_or_none(v):
    """Entero o None: iTunes a veces manda campos ausentes o como texto."""
    if v is None or isinstance(v, bool):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _itunes_album_fields(raw: dict) -> dict:
    """Campos de album de una pista de iTunes (None si iTunes no los trae)."""
    return {
        "collection_id": _int_or_none(raw.get("collectionId")),
        "artist_id": _int_or_none(raw.get("artistId")),
        "track_number": _int_or_none(raw.get("trackNumber")),
        "disc_number": _int_or_none(raw.get("discNumber")),
        "track_count": _int_or_none(raw.get("trackCount")),
        "disc_count": _int_or_none(raw.get("discCount")),
    }


def _itunes_track(raw: dict, match: dict | None = None,
                  *, checked: bool = True) -> Track:
    """Track desde un dict crudo de iTunes (busqueda, album o album matcheado).

    `checked=False` es la tracklist recien abierta: aun no se busco en YouTube,
    asi que `has_full` queda en None ("no verificado") en vez de False.
    """
    m = match or {}
    vid = m.get("video")
    extra = dict(_itunes_album_fields(raw))
    extra["item_url"] = raw.get("trackViewUrl")
    # Alias del storefront jp que encontro el matcher: el veredicto de
    # identidad los usa para que "Mesmerizer" y "メズマライザー" sean el mismo
    # titulo. Las fichas que no los tienen siguen igual (ver `identity_reference`).
    if isinstance(raw.get("aliases"), dict):
        extra["aliases"] = dict(raw["aliases"])
    if checked:
        extra.update({
            "match_score": m.get("score"),
            "match_why": m.get("why"),
            "has_full": bool(vid),
            "needs_resolve": bool(vid),
            "downloader": "ytdlp" if vid else None,
        })
        if vid:
            extra["webpage_url"] = m["webpage_url"]
            extra["video_title"] = vid.get("title")
            extra["channel"] = vid.get("uploader")
    else:
        extra.update({"match_score": None, "match_why": None,
                      "has_full": None, "needs_resolve": None,
                      "downloader": None})
    return Track(
        source="itunes", source_id=_track_key(raw),
        title=raw.get("trackName", ""),
        artist=raw.get("artistName", ""),
        album=raw.get("collectionName"),
        duration_s=(raw.get("trackTimeMillis") or 0) // 1000 or None,
        artwork_url=(raw.get("artworkUrl100") or "").replace(
            "100x100", "300x300") or None,
        preview_url=raw.get("previewUrl"),
        year=(raw.get("releaseDate") or "")[:4] or None,
        license=(("ToS de YouTube (uso personal, riesgo legal)" if vid
                  else "preview de iTunes (30s)") if checked else None),
        extra=extra,
    )


def _album_dict(raw: dict) -> dict:
    return {
        "id": raw.get("collectionId"),
        "artist_id": _int_or_none(raw.get("artistId")),
        "title": raw.get("collectionName"),
        "artist": raw.get("artistName"),
        "year": (raw.get("releaseDate") or "")[:4] or None,
        "track_count": raw.get("trackCount"),
        "artwork_url": (raw.get("artworkUrl100") or "").replace(
            "100x100", "300x300") or None,
        "explicit": raw.get("collectionExplicitness") == "explicit",
    }


def _album_sorted(raws: list[dict]) -> list[dict]:
    """Orden de disco: disco primero y luego numero de pista."""
    def _n(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return 0
    return sorted(raws, key=lambda r: (_n(r.get("discNumber")),
                                       _n(r.get("trackNumber"))))


# --------------------------------------------------------------- discografia
# Clasificacion de lanzamientos de iTunes. Se trabaja sobre el titulo "plegado"
# (sin acentos, en minusculas) para que "En Vivo" y "EN VIVO" den lo mismo.
_SINGLE_SUFFIX_RE = re.compile(r"\s*-\s*(?:single|ep)\s*$", re.I)

# \b evita que "Alive" u "Oliver" se tomen como en vivo. "tour" suelto no
# entra: "Tour de France" es un disco de estudio.
_LIVE_RE = re.compile(
    r"\b(?:live|en vivo|en directo|ao vivo|mtv unplugged|unplugged|"
    r"en concierto|conciertos?|concerts?|gira|world tour)\b")

# iTunes no marca los recopilatorios (collectionType es siempre "Album"): se
# reconocen por el titulo o por el copyright, que dice "Compilacion" o junta
# los anios de varios discos ("1983, 1984, 1985"). Dos anios no bastan: una
# reedicion lleva el original y el del remaster ("1977, 2009").
_COMPILATION_RE = re.compile(
    r"\b(?:hits|greatest|grandes exitos|exitos|best of|lo mejor|esencial|"
    r"essentials?|antologia|anthology|coleccion|collection|mix|mixes|"
    r"remixes|soundtrack|banda sonora|motion picture|the videos)\b")
_COMPILATION_COPYRIGHT_RE = re.compile(
    r"compil|\d{4}\s*,\s*\d{4}\s*,\s*\d{4}")

# Calificadores que iTunes pone entre parentesis o corchetes al final del
# titulo. Al plegar el titulo quedan en minusculas y sin acentos.
_QUALIFIER_RE = re.compile(r"\s*[(\[][^)\]]*[)\]]\s*$")
_QUALIFIER_WORDS = (
    "remaster", "deluxe", "edition", "edicion", "reissue", "reedicion",
    "expanded", "anniversary", "aniversario", "bonus", "limited", "special",
    "especial", "version",
)


def classify_release(raw: dict) -> str:
    """'single', 'live', 'compilation' o 'album'.

    El orden importa: el sufijo de single y las pocas pistas ganan antes que
    la palabra 'live' (un single en directo sigue siendo un single), y un
    directo de grandes exitos es un directo.
    """
    title = raw.get("collectionName") or ""
    folded = fold(title)
    if _SINGLE_SUFFIX_RE.search(title):
        return "single"
    tracks = _int_or_none(raw.get("trackCount"))
    if tracks is not None and tracks <= 3:
        return "single"
    if _LIVE_RE.search(folded):
        return "live"
    if (_COMPILATION_RE.search(folded)
            or _COMPILATION_COPYRIGHT_RE.search(fold(raw.get("copyright")))):
        return "compilation"
    return "album"


def _display_title(title: str) -> str:
    """Titulo a mostrar: sin el sufijo ' - Single'/' - EP' de iTunes."""
    return _SINGLE_SUFFIX_RE.sub("", title or "").strip()


def _normalized_title(title: str) -> str:
    """Clave de dedupe: sin acentos, minusculas y sin calificadores finales."""
    t = fold(_display_title(title))
    while True:
        m = _QUALIFIER_RE.search(t)
        if not m or not any(w in m.group(0) for w in _QUALIFIER_WORDS):
            return " ".join(t.split())
        t = t[:m.start()]


# Sufijos de edicion que iTunes repite al final del titulo. La clave se calcula
# sobre el titulo PLEGADO con fold (sin acentos ni mayusculas), asi que van en
# minusculas. Solo se recorta un grupo final entre parentesis/corchetes si trae
# una de estas palabras: "Theme (Part 2)" y "Song (feat. X)" NO son ediciones
# y se quedan en la clave, para no confundir temas distintos.
_TOP_TAIL_WORDS = (
    "live", "en vivo", "acoustic", "acustico", "unplugged", "remaster",
    "remastered", "version", "edit", "radio", "demo", "mono", "stereo",
    "instrumental", "karaoke", "cover", "mix", "deluxe", "bonus",
)
_EDICION = "|".join(re.escape(w) for w in _TOP_TAIL_WORDS)
_TOP_SUFFIX_RE = re.compile(
    r"\s*(?:[(\[][^)\]]*\b(?:" + _EDICION + r")\b[^)\]]*[)\]]"
    r"|[-–]\s*(?:" + _EDICION + r")\b.*)\s*$",
    re.IGNORECASE)


def _top_song_key(raw: dict) -> str:
    """Clave de dedupe del top: titulo plegado y sin sufijos de edicion.

    Reutiliza `fold`, el plegador de nombres del matching: quita acentos, baja
    a minusculas y colapsa espacios. Despues saca los sufijos entre parentesis
    o corchetes y los que van detras de un guion ("- Live", "- Acoustic"), para
    que dos versiones del mismo tema cuenten como una sola.
    """
    titulo = fold(raw.get("trackName", ""))
    while titulo.strip():
        m = _TOP_SUFFIX_RE.search(titulo)
        if not m:
            return " ".join(titulo.split())
        titulo = titulo[:m.start()]
    # Vacio (o solo un sufijo): clave unica por id, no todos juntos.
    return f"__sin_titulo__{raw.get('trackId')}"


def _release_dict(raw: dict) -> dict:
    """Ficha de un lanzamiento, con el mismo formato que _album_dict."""
    return {
        "id": _int_or_none(raw.get("collectionId")),
        "title": _display_title(raw.get("collectionName") or ""),
        "artist": raw.get("artistName"),
        "year": (raw.get("releaseDate") or "")[:4] or None,
        "track_count": _int_or_none(raw.get("trackCount")),
        "artwork_url": (raw.get("artworkUrl100") or "").replace(
            "100x100", "300x300") or None,
        "explicit": raw.get("collectionExplicitness") == "explicit",
    }


def _edition_rank(raw: dict) -> tuple:
    """Menor = mejor edicion para bajar: la explicita, la que tiene menos
    pistas (la original y no la deluxe de 60) y, si empatan, la primera."""
    tracks = _int_or_none(raw.get("trackCount"))
    return (raw.get("collectionExplicitness") != "explicit",
            tracks if tracks is not None else 10**6,
            raw.get("releaseDate") or "")


def _build_releases(collections: list[dict]) -> dict[str, list[dict]]:
    """Clasifica, deduplica y ordena (mas nuevo primero) cada grupo.

    Duplicados = mismo titulo normalizado dentro del grupo; se queda la
    edicion de `_edition_rank`.
    """
    grupos: dict[str, dict[str, dict]] = {
        "album": {}, "live": {}, "compilation": {}, "single": {}}
    for raw in collections:
        kind = classify_release(raw)
        key = _normalized_title(raw.get("collectionName"))
        anterior = grupos[kind].get(key)
        if anterior is None or _edition_rank(raw) < _edition_rank(anterior):
            grupos[kind][key] = raw
    # Un disco de estudio cuyo copyright junta anios no es un recopilatorio
    # si su reedicion ya esta entre los albumes.
    for key in grupos["album"]:
        grupos["compilation"].pop(key, None)
    return {kind: [_release_dict(r) for r in sorted(
                por_titulo.values(), key=lambda r: r.get("releaseDate") or "",
                reverse=True)]
            for kind, por_titulo in grupos.items()}


async def _album_lookup(album_id: str) -> tuple[dict, list[dict]]:
    """Cabecera y tracklist de un album, con id validado y errores acotados."""
    album_id = str(album_id)
    if not album_id.isdigit():
        # Un id raro no puede llegar a iTunes: es directamente 404.
        raise HTTPException(404, "album no encontrado")
    itunes = BY_NAME["itunes"]  # fuente registrada: reutiliza su httpx.Client
    try:
        collection, raws = await itunes.lookup(album_id)
    except Exception as e:
        # Red o HTTP de iTunes caido: nunca un 500 en estas rutas.
        log.warning("iTunes lookup fallo: %s", e)
        raise HTTPException(502, "iTunes no respondio") from e
    if not raws:
        raise HTTPException(404, "album no encontrado")
    # El wrapper trae el artistName del album; si no vino, se usa la primera
    # pista como antes. En compilaciones eso evita mostrar un solista cualquiera.
    base = collection or raws[0]
    return _album_dict(base), _album_sorted(raws)


async def albums_search(request: Request):
    q = _query_str(request, "q", required=True, min_length=1, max_length=200)
    limit = _query_int(request, "limit", 8, 1, 50)
    try:
        raws = await BY_NAME["itunes"].search_albums(q, limit=limit)
    except Exception as e:
        # iTunes caido no puede tumbar la busqueda de albumes.
        log.warning("albums search fallo: %s", e)
        raws = []
    return JSONResponse({"query": q, "albums": [_album_dict(a) for a in raws]})


async def album_detail(request: Request):
    album, raws = await _album_lookup(request.path_params["id"])
    return JSONResponse({
        "album": album,
        "tracks": [_itunes_track(r, checked=False).to_dict() for r in raws],
    })


async def artists_search(request: Request):
    q = _query_str(request, "q", required=True, min_length=1, max_length=200)
    limit = _query_int(request, "limit", 5, 1, 20)
    try:
        raws = await BY_NAME["itunes"].search_artists(q, limit=limit)
    except Exception as e:
        # Igual que albums_search: iTunes caido no tumba la busqueda.
        log.warning("artists search fallo: %s", e)
        raws = []
    return JSONResponse({"query": q, "results": [_artist_dict(a) for a in raws]})


def _artist_dict(raw: dict) -> dict:
    """Un artista de iTunes tal como lo ve el frontend (ruta y ola de Buscar)."""
    return {
        "id": _int_or_none(raw.get("artistId")),
        "name": raw.get("artistName"),
        "genre": raw.get("primaryGenreName"),
    }


async def artist_detail(request: Request):
    artista_id = str(request.path_params["id"])
    if not artista_id.isdigit():
        # Misma verificacion de digitos que album_detail, pero aqui el id
        # mal formado es 422 (cuerpo de error FastAPI).
        raise _invalid(["path", "id"], "Input should be a valid integer")
    try:
        raws = await BY_NAME["itunes"].artist_albums(artista_id)
    except Exception as e:
        log.warning("artist albums fallo: %s", e)
        raise HTTPException(502, "iTunes no respondio") from e
    wrapper = next((r for r in raws
                    if r.get("wrapperType") == "artist"), None)
    if not wrapper:
        raise HTTPException(404, "artista no encontrado")
    # Las recopilaciones de "Varios artistas" pueden colarse: solo se quedan
    # las colecciones cuyo artistId es el del artista pedido.
    colecciones = [r for r in raws
                   if r is not wrapper
                   and r.get("collectionId")
                   and r.get("collectionName")
                   and str(r.get("artistId")) == artista_id]
    releases = _build_releases(colecciones)
    albums = releases["album"]
    return JSONResponse({
        "id": _int_or_none(wrapper.get("artistId")) or _int_or_none(artista_id),
        "name": wrapper.get("artistName"),
        "genre": wrapper.get("primaryGenreName"),
        # iTunes no da fotos de artista: se usa la portada del disco mas nuevo.
        "artwork_url": albums[0]["artwork_url"] if albums else None,
        "albums": albums,
        "live": releases["live"],
        "compilations": releases["compilation"],
        "singles": releases["single"],
    })


def _artist_top_cache_get(artista_id: str) -> dict | None:
    """Top cacheado por id de artista, o None si vencio/no existe."""
    hit = _ARTIST_TOP_CACHE.get(artista_id)
    if not hit:
        return None
    guardado, payload = hit
    if time.time() - guardado >= _ARTIST_TOP_TTL_S:
        _ARTIST_TOP_CACHE.pop(artista_id, None)
        return None
    return payload


def _artist_top_cache_put(artista_id: str, payload: dict) -> None:
    """Guarda con expulsion por antiguedad, igual que el match de albumes."""
    ahora = time.time()
    _ARTIST_TOP_CACHE[artista_id] = (ahora, payload)
    if len(_ARTIST_TOP_CACHE) > _ARTIST_TOP_MAX:
        vieja = min(_ARTIST_TOP_CACHE,
                    key=lambda k: _ARTIST_TOP_CACHE[k][0])
        _ARTIST_TOP_CACHE.pop(vieja, None)


async def _buscar_pista_suelta(raw: dict, ysrc, *,
                               sem: asyncio.Semaphore | None = None,
                               artista: str = "",
                                priority: bool = False) -> dict:
    """Busca UNA pista con su artista y su titulo, con concurrencia acotada.

    La comparten el segundo paso del top de artista, el del match de albumes,
    el stream de busqueda y la ruta lazy. En recopilatorios el artista del
    album es "Varios artistas": la pista busca con el SUYO, no con ese.
    Antes de buscar consulta la cache; con el circuito abierto no busca.
    `priority=True` (tap del usuario) salta el limite compartido.
    """
    clave = _track_key(raw)
    hit = _track_match_cache_get(clave)
    if hit is not None:
        # Los llamadores esperan el indice por clave, igual que el matcher.
        return {clave: hit[0]}
    if _breaker_abierto():
        return {}

    from .matcher import enrich_with_ytdlp

    async def _buscar() -> dict:
        track_artist = raw.get("artistName") or artista
        query = f"{track_artist} {raw.get('trackName', '')}".strip()
        yt = _YtConCircuito(ysrc)
        # Corrutina sin await: la cubre el try/except de enrich_with_ytdlp, asi
        # un muro o un fallo de red siguen cayendo a "sin video" en vez de
        # tumbar la ruta (igual que la busqueda grupal en _search_songs_eventos).
        # Solo se crea si se va a esperar: sin YouTube quedaria sin await.
        videos = (_search_candidates_cached(yt, query, _ALBUM_TRACK_LIMIT)
                  if yt.available() else None)
        res = await enrich_with_ytdlp(
            [raw], query, yt, limit=_ALBUM_TRACK_LIMIT, videos=videos)
        # Sin la clave la busqueda fallo (red, muro): no es un "no hay video"
        # y no se guarda, o la pista quedaria diez minutos en 30 s.
        if clave in res:
            _track_match_cache_put(clave, res[clave])
        return res

    if priority or sem is None:
        return await _buscar()
    async with sem:
        return await _buscar()


async def artist_top_songs(request: Request):
    """GET /api/artist/{id}/top -> { id, name, songs: [Track, ...] }.

    Canciones destacadas de iTunes con el MISMO match de YouTube que /api/search
    (modo Musica), para que se toquen igual. Va en ruta aparte: emparejar en
    YouTube tarda y no puede retrasar el primer pintado de la pagina del artista.
    iTunes caido, id desconocido o YouTube apagado nunca rompen la pagina: se
    devuelve la lista (vacia o con previews) con 200.
    """
    artista_id = str(request.path_params["id"])
    if not artista_id.isdigit():
        raise _invalid(["path", "id"], "Input should be a valid integer")
    hit = _artist_top_cache_get(artista_id)
    if hit is not None:
        return JSONResponse(hit)

    async with _top_lock(artista_id):
        # Mientras esperabamos el lock otro pedido pudo llenar la cache.
        hit = _artist_top_cache_get(artista_id)
        if hit is not None:
            return JSONResponse(hit)

        ident = _int_or_none(artista_id)
        try:
            raws = await BY_NAME["itunes"].artist_top_songs(
                artista_id, limit=ITUNES_TOP_LOOKUP_LIMIT)
        except Exception as e:
            log.warning("artist top songs fallo: %s", e)
            # Un fallo de red no se cachea: la pagina lo reintentara al volver.
            return JSONResponse({"id": ident, "name": None, "songs": []})

        from .matcher import credits_artist
        wrapper = next((r for r in raws if r.get("wrapperType") == "artist"), None)
        page_name = (wrapper or {}).get("artistName") or ""
        # iTunes a veces mezcla items de otros artistas en el lookup. Se queda
        # lo que es del artista: por id, o porque lo nombra el credito o un
        # "feat." del titulo (en Kasane Teto casi todo va a nombre del productor).
        raws = [r for r in raws if r.get("kind") == "song" and (
            str(r.get("artistId")) == artista_id
            or credits_artist(page_name, r.get("artistName", ""),
                              r.get("trackName", "")))]
        # Y repite el mismo tema en varias ediciones. Se dedupe ANTES del tope,
        # quedandose con la primera (la que iTunes puso mas arriba en el ranking).
        vistos: set[str] = set()
        unicos: list[dict] = []
        for raw in raws:
            clave = _top_song_key(raw)
            if clave in vistos:
                continue
            vistos.add(clave)
            unicos.append(raw)
        raws = unicos[:TOP_SONGS_LIMIT]
        name = page_name or (raws[0].get("artistName") if raws else None)
        songs: list[dict] = []
        match_fallo = False
        if raws:
            from .matcher import enrich_with_ytdlp
            _register_ytdlp()
            ysrc = BY_NAME.get("ytdlp")
            yt_on = bool(ysrc and ysrc.available())
            query = (name or "").strip()
            # Una unica busqueda en YouTube, lanzada ya, reparte los videos entre
            # las canciones: el mismo limite y concurrencia que /api/search.
            videos = (asyncio.ensure_future(ysrc.search_candidates(query, limit=40))
                      if yt_on else None)
            try:
                matched = (await enrich_with_ytdlp(
                    raws, query, ysrc, videos=videos)) if yt_on else {}
                _track_match_cache_put_muchos(matched)
            except Exception as e:
                log.warning("artist top match fallo: %s", e)
                matched = {}
                match_fallo = True
                if videos:
                    videos.cancel()

            # 2) las que quedaron sin video se buscan sueltas, igual que en
            # albumes: el video de una pista puede no estar entre los 40 de la
            # busqueda del artista. Un fallo puntual no tumba el endpoint: esa
            # pista se queda con el preview y ya.
            if not match_fallo:
                misses = [r for r in raws
                          if not (matched.get(_track_key(r)) or {}).get("video")]
                if misses:
                    sem = asyncio.Semaphore(_ALBUM_MATCH_SEMAPHORE)

                    async def _una(raw):
                        return raw, await _buscar_pista_suelta(raw, ysrc, sem=sem)

                    tareas = [asyncio.create_task(_una(r)) for r in misses]
                    try:
                        resultados = await asyncio.gather(
                            *tareas, return_exceptions=True)
                    finally:
                        for t in tareas:
                            if not t.done():
                                t.cancel()
                        await asyncio.gather(*tareas, return_exceptions=True)
                    for res in resultados:
                        if isinstance(res, BaseException):
                            log.warning("artist top busqueda suelta fallo: %s", res)
                            continue
                        _, res_match = res
                        for clave, m in res_match.items():
                            if (m or {}).get("video"):
                                matched[clave] = m

            songs = [_itunes_track(r, matched.get(_track_key(r))).to_dict()
                     for r in raws]

        payload = {"id": ident, "name": name, "songs": songs}
        # YouTube caido es transitorio: no se guarda media hora. Sin match no
        # hay cache, asi el proximo pedido vuelve a intentarlo.
        if not match_fallo:
            _artist_top_cache_put(artista_id, payload)
        return JSONResponse(payload)


def _guardar_match_en_cache(album_id: str, ahora: float, payload: dict) -> None:
    """Guarda la respuesta final del match, con expulsion por antiguedad."""
    _ALBUM_MATCH_CACHE[album_id] = (ahora, payload)
    if len(_ALBUM_MATCH_CACHE) > _ALBUM_MATCH_MAX:
        vieja = min(_ALBUM_MATCH_CACHE,
                    key=lambda k: _ALBUM_MATCH_CACHE[k][0])
        _ALBUM_MATCH_CACHE.pop(vieja, None)


async def _album_match_eventos(album_id: str):
    """Generador comun de las dos rutas de match.

    Emite (tipo, datos): `album` con la cabecera, un `tracks` por lote de
    pistas recien matcheadas (a medida que llegan) y `done` con el payload
    final y TODAS las pistas. La ruta JSON se queda con `done`; la de stream
    manda todo. Si el consumidor se va, las busquedas sueltas se cancelan.
    """
    ahora = time.time()
    hit = _ALBUM_MATCH_CACHE.get(album_id)
    if hit and ahora - hit[0] < _ALBUM_MATCH_TTL_S:
        yield "album", {"album": hit[1]["album"], "ytdlp": hit[1]["ytdlp"]}
        yield "done", hit[1]
        return

    from .matcher import enrich_with_ytdlp
    from .sources import BY_NAME
    _register_ytdlp()
    ysrc = BY_NAME.get("ytdlp")
    yt_on = bool(ysrc and ysrc.available())

    album, raws = await _album_lookup(album_id)
    yield "album", {"album": album, "ytdlp": yt_on}

    matched: dict = {}
    por_clave = {_track_key(r): r for r in raws}

    def _track(clave: str) -> dict:
        return _itunes_track(por_clave[clave], matched.get(clave)).to_dict()

    if yt_on:
        artista = album.get("artist") or ""
        titulo = album.get("title") or ""
        # 1) una busqueda para TODO el album: reparte los videos entre pistas.
        res = await enrich_with_ytdlp(
            raws, f"{artista} {titulo}".strip(), ysrc)
        _track_match_cache_put_muchos(res)
        nuevos = []
        for clave, m in res.items():
            if (m or {}).get("video") and clave in por_clave:
                matched[clave] = m
                nuevos.append(_track(clave))
        yield "tracks", {"tracks": nuevos}

        # 2) las que quedaron sin video se buscan sueltas, de a 3 como maximo.
        misses = [r for r in raws
                  if not (matched.get(_track_key(r)) or {}).get("video")]
        if misses:
            sem = asyncio.Semaphore(_ALBUM_MATCH_SEMAPHORE)

            async def _una(raw):
                # En recopilatorios el artista del album es "Varios
                # artistas": la pista busca con el SUYO, no con ese.
                return raw, await _buscar_pista_suelta(
                    raw, ysrc, sem=sem, artista=artista)

            tareas = [asyncio.create_task(_una(r)) for r in misses]
            try:
                for lista in asyncio.as_completed(tareas):
                    raw, res = await lista
                    nuevos = []
                    for clave, m in res.items():
                        if (m or {}).get("video") and clave in por_clave:
                            matched[clave] = m
                            nuevos.append(_track(clave))
                    # Una linea por busqueda que termina. Puede venir vacia:
                    # esa pista solo se informa en `done`.
                    yield "tracks", {"tracks": nuevos}
            finally:
                # Cliente desconectado: no dejar busquedas huerfanas.
                for t in tareas:
                    if not t.done():
                        t.cancel()
                await asyncio.gather(*tareas, return_exceptions=True)

    tracks = [_itunes_track(r, matched.get(_track_key(r))).to_dict()
              for r in raws]
    payload = {
        "album": album, "tracks": tracks, "ytdlp": yt_on,
        "full": sum(1 for t in tracks if t["extra"].get("has_full")),
    }
    if yt_on:
        _guardar_match_en_cache(album_id, ahora, payload)
    yield "done", payload


def _match_stream_response(eventos, primero,
                           done_keys=("full", "tracks")) -> StreamingResponse:
    """NDJSON: un objeto JSON por linea, en el orden de los eventos.

    `done_keys` recorta el payload final al conjunto de claves que viajan en
    el ultimo evento (el album manda tracks; la busqueda, full y count).
    """
    async def cuerpo():
        try:
            tipo, datos = primero
            while True:
                if tipo == "done":
                    # En el cable `done` lleva solo el resultado: album e
                    # ytdlp ya vinieron en la primera linea.
                    datos = {k: datos.get(k, 0) for k in done_keys}
                yield (json.dumps({"type": tipo, **datos},
                                  ensure_ascii=False) + "\n").encode("utf-8")
                try:
                    tipo, datos = await eventos.__anext__()
                except StopAsyncIteration:
                    break
        finally:
            # Si el cliente corto, aclose dispara el finally del generador
            # compartido y cancela lo que todavia estuviera buscando.
            await eventos.aclose()

    return StreamingResponse(cuerpo(), media_type="application/x-ndjson")


async def album_match(request: Request):
    album_id = str(request.path_params["id"])
    if not album_id.isdigit():
        # Igual que _album_lookup, pero antes de abrir un stream: asi las dos
        # rutas responden 404 con el mismo cuerpo.
        raise HTTPException(404, "album no encontrado")
    if _query_str(request, "stream", default=None) in ("1", "true", "yes"):
        eventos = _album_match_eventos(album_id)
        # El primer evento se saca aca, antes de abrir el stream: el lookup de
        # iTunes puede tirar 404/502 y esos si los maneja Starlette. Ya arrancado
        # el stream, un HTTPException solo daria un 500 con la respuesta a medias.
        try:
            primero = await eventos.__anext__()
        except StopAsyncIteration:
            primero = ("done", {"full": 0, "tracks": []})
        return _match_stream_response(eventos, primero)
    # Ruta JSON de siempre: se descartan los lotes intermedios y se devuelve
    # solo el payload final (mismo cuerpo y misma cache que antes).
    payload = None
    async for tipo, datos in _album_match_eventos(album_id):
        if tipo == "done":
            payload = datos
    return JSONResponse(payload)


# Los estantes (artistas y albumes) se esperan como mucho esto desde que
# contesta iTunes para ir en el catalogo; si no, salen solos en `shelves`.
_SHELVES_WAIT_S = 1.2
# Tope antes de `done`: unos estantes colgados no retienen el final del stream.
_SHELVES_MAX_S = 8.0


async def _search_shelves(q: str) -> dict:
    """«Mejor resultado» y «Albumes» de la ola: las mismas busquedas que
    /api/artists/search y /api/albums/search. Un fallo deja su lista vacia y
    nunca tumba la busqueda de canciones."""
    isrc = BY_NAME["itunes"]

    async def _una(buscar, mapa, que):
        try:
            return [mapa(r) for r in await buscar()]
        except Exception as e:
            log.warning("%s search fallo: %s", que, e)
            return []

    artists, albums = await asyncio.gather(
        _una(lambda: isrc.search_artists(q, limit=3), _artist_dict, "artists"),
        _una(lambda: isrc.search_albums(q, limit=8), _album_dict, "albums"))
    return {"artists": artists, "albums": albums}


async def _search_matched_eventos(q: str, limit: int, *,
                                  stream: bool = False):
    """Modo Musica: las canciones y, en el stream, los estantes.

    Artistas y albumes se buscan en paralelo con las canciones. Si estan
    listos a tiempo viajan en el `catalog`, asi todo pinta de una vez; si no,
    salen en un evento `shelves` en cuanto terminan (entre lotes, y siempre
    antes de `done`). Sin stream es la respuesta de siempre.
    """
    canciones = _search_songs_eventos(q, limit, stream=stream)
    if not stream:
        async for ev in canciones:
            yield ev
        return
    estantes = asyncio.ensure_future(_search_shelves(q))
    # `catalogo`: ya salio la primera linea (antes no se adelantan estantes).
    catalogo = enviados = False
    siguiente = None
    try:
        while True:
            if siguiente is None and (not catalogo or enviados):
                ev = await canciones.__anext__()
            else:
                # Lo que llegue primero: un evento de canciones o los estantes.
                # El pedido en vuelo se conserva: un generador no admite dos.
                siguiente = siguiente or asyncio.ensure_future(canciones.__anext__())
                if not enviados:
                    await asyncio.wait({siguiente, estantes},
                                       return_when=asyncio.FIRST_COMPLETED)
                    if not siguiente.done():
                        enviados = True
                        yield "shelves", estantes.result()
                        continue
                ev, siguiente = await siguiente, None
            tipo, datos = ev
            if tipo == "catalog":
                catalogo = True
                await asyncio.wait({estantes}, timeout=_SHELVES_WAIT_S)
                if estantes.done():
                    enviados = True
                    datos = {**datos, **estantes.result()}
            elif not enviados and (tipo == "done" or estantes.done()):
                if tipo == "done":
                    await asyncio.wait({estantes}, timeout=_SHELVES_MAX_S)
                enviados = True
                yield "shelves", (estantes.result() if estantes.done()
                                  else {"artists": [], "albums": []})
            yield tipo, datos
            if tipo == "done":
                return
    except StopAsyncIteration:
        return
    finally:
        # Cliente desconectado (o iTunes caido): nada queda buscando.
        if siguiente is not None and not siguiente.done():
            siguiente.cancel()
            await asyncio.gather(siguiente, return_exceptions=True)
        if not estantes.done():
            estantes.cancel()
        await canciones.aclose()


async def _search_songs_eventos(q: str, limit: int, *,
                                stream: bool = False):
    """Modo Musica con eventos progresivos.

    `catalog` se emite apenas contesta iTunes, antes de que termine el match de
    YouTube. Con `stream=True` lo que el grupo no emparejo queda `lazy`: se
    busca suelto recien al hacerse visible (o al tocar la fila), nunca aca
    adentro, asi `done` no espera ningun ytsearch por pista. Sin stream se
    conserva la respuesta de siempre: una sola busqueda grupal, orden
    full-first y ninguna busqueda suelta.
    """
    from .ytdlp_source import ensure_yt_dlp_imported
    await ensure_yt_dlp_imported()
    from .matcher import catalog_status, enrich_with_ytdlp
    _register_ytdlp()
    ysrc = BY_NAME.get("ytdlp")
    yt_on = bool(ysrc and ysrc.available())

    # 1) catalogo de iTunes y busqueda grupal de YouTube en paralelo: la de
    # YouTube solo depende de la consulta y es el paso mas lento. Una consulta
    # repetida la sirve la cache de candidatos sin pedirle nada a YouTube.
    isrc = BY_NAME["itunes"]
    videos = None
    if yt_on:
        videos = asyncio.ensure_future(_search_candidates_cached(
            _YtConCircuito(ysrc), q, _GROUP_SEARCH_LIMIT))
        # Si nadie llega a esperarla (sin resultados, todo cacheado), que su
        # error no quede como "exception was never retrieved".
        videos.add_done_callback(
            lambda f: None if f.cancelled() else f.exception())
    try:
        it_items = await isrc._raw_search(q, limit=min(limit, 30))
    except BaseException:
        if videos:
            videos.cancel()
        raise
    catalog = catalog_status(q, it_items)
    if not it_items:
        if videos:
            videos.cancel()
        yield "catalog", {"query": q, "mode": "matched", "ytdlp": yt_on,
                          "catalog": catalog, "count": 0, "results": []}
        # El cuerpo vacio de siempre no tenia clave `full`.
        yield "done", {"query": q, "mode": "matched", "count": 0,
                       "results": [], "ytdlp": yt_on, "catalog": catalog}
        return

    _track_raw_put(it_items)
    inicial = "pending" if (stream and yt_on) else "none"
    estado = {_track_key(it): inicial for it in it_items}
    matches: dict = {}

    def _fila(raw: dict, state: str) -> dict:
        t = _itunes_track(raw, matches.get(_track_key(raw))
                          if state == "full" else None)
        if state in ("pending", "lazy"):
            t.extra["has_full"] = None
        t.extra["match_state"] = state
        return t.to_dict()

    # Aciertos de busquedas anteriores van ya en el catalogo: una busqueda
    # repetida no espera a YouTube para mostrar lo que ya se sabe.
    if yt_on:
        for clave in estado:
            hit = _track_match_cache_get(clave)
            if hit is not None and hit[1]:
                matches[clave] = hit[0]
                estado[clave] = "full"
    enviado = dict(estado)

    try:
        yield "catalog", {"query": q, "mode": "matched", "ytdlp": yt_on,
                          "catalog": catalog, "count": len(it_items),
                          "results": [_fila(it, estado[_track_key(it)])
                                      for it in it_items]}
    except BaseException:
        # Cliente desconectado recien mostrado el catalogo: la busqueda de
        # candidatos ya estaba en vuelo y nadie la va a esperar.
        if videos:
            videos.cancel()
        raise

    # 2) un solo match grupal reparte los candidatos entre las que faltan. Lo
    # ya cacheado queda fuera (sus videos no le quitan sitio a las demas) y,
    # si no falta nada, la busqueda en YouTube se cancela.
    faltan = [it for it in it_items if estado[_track_key(it)] != "full"]
    if yt_on and faltan:
        try:
            res = await enrich_with_ytdlp(faltan, q, ysrc,
                                          limit=_GROUP_SEARCH_LIMIT, videos=videos)
        finally:
            # Cliente desconectado (o iTunes/matcher tiro): no dejar la
            # busqueda de candidatos volando sin nadie que la espere.
            if not videos.done():
                videos.cancel()
        _track_match_cache_put_muchos(res)
        for clave, m in res.items():
            if (m or {}).get("video") and clave in estado:
                matches[clave] = m
                estado[clave] = "full"
    elif videos:
        videos.cancel()

    # Nadie busca mas en este momento: lo que sigue sin video se resuelve al
    # hacerse visible (scroll) o al tocar la fila, con su propio pedido.
    if stream:
        for clave in estado:
            if estado[clave] == "pending":
                estado[clave] = "lazy"

    cambiadas = [it for it in it_items
                 if estado[_track_key(it)] != enviado[_track_key(it)]]
    if cambiadas:
        yield "tracks", {"tracks": [_fila(it, estado[_track_key(it)])
                                    for it in cambiadas]}

    # 3) payload final; la ruta JSON lo devuelve entero y el stream solo saca
    # `full` y `count` (el frontend ya tiene las filas de los lotes).
    out = []
    for it in it_items:
        clave = _track_key(it)
        state = estado[clave]
        t = _itunes_track(it, matches.get(clave) if state == "full" else None)
        if state in ("pending", "lazy"):
            t.extra["has_full"] = None
        t.extra["match_state"] = state if stream else (
            "full" if state == "full" else "none")
        out.append(t)
    if not stream:
        out.sort(key=lambda t: 0 if t.extra.get("has_full") else 1)
    yield "done", {
        "query": q, "mode": "matched", "ytdlp": yt_on, "catalog": catalog,
        "count": len(out),
        "full": sum(1 for t in out if t.extra["match_state"] == "full"),
        "results": [t.to_dict() for t in out],
    }


async def _search_matched(q: str, limit: int) -> dict:
    """JSON de siempre: una busqueda grupal, full-first, sin eventos sueltos."""
    payload = None
    async for tipo, datos in _search_matched_eventos(q, limit):
        if tipo == "done":
            payload = datos
    return payload


def _group_shows(tracks: list[Track]) -> list[Track]:
    """Agrupa los items de un mismo concierto en una fila con el setlist."""
    out: list[Track] = []
    by_show: dict[str, Track] = {}
    for t in tracks:
        show = t.extra.get("show")
        if not show or t.source != "archive":
            out.append(t)
            continue
        key = f"{t.artist}|{show}"
        if key in by_show:
            g = by_show[key]
            n = g.extra.setdefault("track_count", 1) + 1
            g.extra["track_count"] = n
            g.extra.setdefault("item_ids", [g.source_id]).append(t.source_id)
        else:
            t.extra["track_count"] = 1
            t.extra["item_ids"] = [t.source_id]
            t.extra["is_group"] = True
            by_show[key] = t
            out.append(t)
    return out


async def resolve(request: Request):
    """Completa audio_url y VERIFICA la identidad real del archivo.

    query: lo que el usuario escribio. Se usa para leer los tags del audio y
    decir si lo que vas a bajar es realmente lo que buscabas.
    """
    query = _query_str(request, "query", default=None)
    payload = TrackPayload.from_dict(await _json_body(request), ["body"])
    src = BY_NAME.get(payload.source)
    if not src:
        raise HTTPException(400, f"fuente desconocida: {payload.source}")
    t = payload.to_track()
    try:
        if t.source == "ytdlp":
            # resolver via el mismo cache/camino rapido que /api/stream: antes
            # esta ruta hacia su PROPIA extraccion completa (youtube_opts, sin
            # visitor_data) y /api/stream volvia a resolver el mismo video
            # para reproducirlo. Con esto queda una sola extraccion por toque.
            url = t.extra.get("webpage_url")
            if not url:
                raise ValueError("falta webpage_url")
            from . import stream as stream_mod
            from .ytdlp_source import ensure_yt_dlp_imported
            await ensure_yt_dlp_imported()
            info = await stream_mod.resolve(url)
            t.audio_url = info.url
            t.license = "ToS de la plataforma (uso personal)"
            from .identify import similarity, verdict
            from .ytdlp_source import identity_query
            q_id = identity_query(query, t.title)
            state, label = verdict(q_id, t.title)
            t.extra.update({"real_title": t.title, "match": state,
                            "match_label": label, "match_score": round(
                                similarity(q_id, t.title), 2)})
        else:
            t = await src.resolve(t, query=query)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        log.exception("resolve fallo en %s", payload.source)
        raise HTTPException(502, f"no se pudo resolver: {e}")
    return JSONResponse(t.to_dict())


async def verify(request: Request):
    """Dice que hay adentro de un resultado SIN bajarlo.

    Devuelve el titulo real leido de los tags, de donde viene (item/file/URL)
    y si coincide con lo que buscabas.
    """
    q = _query_str(request, "q", required=True, min_length=1, max_length=200)
    source = _query_str(request, "source", default="archive")
    source_id = _query_str(request, "source_id", required=True)
    src = BY_NAME.get(source)
    if not src:
        raise HTTPException(400, f"fuente desconocida: {source}")
    t = Track(source=source, source_id=source_id, title=q, artist="")
    try:
        t = await src.resolve(t, query=q)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(502, f"no se pudo verificar: {e}")
    return JSONResponse(t.to_dict())


async def progress(request: Request):
    """Progreso de una descarga yt-dlp en curso (la UI hace polling).

    Sigue respondiendo igual para jobs sueltos; para items de la cola muestra
    "queued" mientras esperan el semaforo y, si el proceso se reinicio, utiliza
    el item persistido cuando el job en memoria ya no existe.
    """
    job_id = request.path_params["job_id"]
    from .ytdlp_source import get_job
    job = get_job(job_id)
    item = downloads.get_item(job_id)
    if job is not None:
        payload = {"job_id": job_id, **job}
        if item is not None and item.get("status") == "queued":
            payload["status"] = "queued"
        return JSONResponse(payload)
    if item is not None:
        return JSONResponse({"job_id": job_id, **downloads.job_view(item)})
    return JSONResponse({"status": "unknown", "job_id": job_id})


# --------------------------------------------------------------------- cola
async def downloads_list(request: Request):
    """GET /api/downloads: items vigentes (grupo nuevo primero) y contadores."""
    return JSONResponse(downloads.list_payload())


async def downloads_enqueue(request: Request):
    """POST /api/downloads: encola varios items y devuelve sus ids y claves."""
    body = await _json_body(request)
    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise _invalid(["body", "items"], "Field required")
    group = body.get("group")
    if group is not None and not isinstance(group, dict):
        raise _invalid(["body", "group"], "Input should be a valid dictionary")

    from .ytdlp_source import key_base_for
    specs: list[dict] = []
    for i, raw in enumerate(raw_items):
        if not isinstance(raw, dict):
            raise _invalid(["body", "items", i], "Input should be a valid dictionary")
        src = raw.get("source")
        if not isinstance(src, str):
            raise _invalid(["body", "items", i, "source"], "Field required")
        t = raw.get("track")
        if not isinstance(t, dict):
            raise _invalid(["body", "items", i, "track"], "Field required")
        fmt = raw.get("fmt", "original")
        if not isinstance(fmt, str):
            raise _invalid(["body", "items", i, "fmt"], "Input should be a valid string")
        media = raw.get("media", "audio")
        if not isinstance(media, str) or media not in _MEDIA_CHOICES:
            raise _invalid(["body", "items", i, "media"], "Input should be a valid string")
        height = _height_field({"height": raw.get("height")}, media)
        query = raw.get("query")
        if query is not None and not isinstance(query, str):
            raise _invalid(["body", "items", i, "query"], "Input should be a valid string")
        track = TrackPayload.from_dict(t, ["body", "items", i, "track"]).to_track()
        specs.append({
            "source": src, "track": track.to_dict(), "fmt": fmt,
            "media": media, "height": height, "query": query,
            "key_base": key_base_for(track, media, height),
            "ident": {
                "match": track.extra.get("match"),
                "match_label": track.extra.get("match_label"),
                "real_title": track.extra.get("real_title"),
                "real_artist": track.extra.get("real_artist"),
                "item_url": track.extra.get("webpage_url") or track.extra.get("item_url"),
            },
        })
    return JSONResponse({"items": downloads.enqueue(specs, group)})


async def downloads_network(request: Request):
    """POST /api/downloads/network: informa la conexion y las preferencias.

    La UI (Bridge de Android o `navigator.connection`) dice si hay red, si es
    Wi-Fi y si el usuario exige Wi-Fi / prohibe roaming. Con eso la cola decide
    si un item puede empezar o debe esperar con fase «Esperando Wi-Fi».
    """
    body = await _json_body(request)
    tipo = body.get("type")
    if tipo is not None and not isinstance(tipo, str):
        raise _invalid(["body", "type"], "Input should be a valid string")
    return JSONResponse(downloads.set_network(
        type=tipo,
        online=body.get("online"),
        wifi_only=body.get("wifi_only"),
        roaming_allowed=body.get("roaming_allowed")))


async def downloads_cancel(request: Request):
    """POST /api/downloads/{id}/cancel: cancela un item en cola o en curso."""
    item_id = request.path_params["id"]
    try:
        item = downloads.cancel(item_id)
    except downloads.NotFound:
        raise HTTPException(404, "descarga no encontrada")
    except downloads.AlreadyFinished:
        raise HTTPException(409, "la descarga ya termino")
    return JSONResponse({"id": item_id, "status": item["status"]})


async def downloads_cancel_group(request: Request):
    """POST /api/downloads/cancel: cancela todos los items pendientes de un grupo."""
    body = await _json_body(request)
    group_id = body.get("group_id")
    if not isinstance(group_id, str) or not group_id:
        raise _invalid(["body", "group_id"], "Field required")
    return JSONResponse({"cancelled": downloads.cancel_group(group_id)})


async def downloads_retry(request: Request):
    """POST /api/downloads/{id}/retry: vuelve a encolar un item fallido/cancelado."""
    item_id = request.path_params["id"]
    try:
        salida = downloads.retry(item_id)
    except downloads.NotFound:
        raise HTTPException(404, "descarga no encontrada")
    except downloads.AlreadyFinished:
        raise HTTPException(409, "la descarga todavia no termino")
    return JSONResponse(salida)


#: Forma canonica de una URL de UN video de YouTube (`parse_youtube_url`).
_YT_WATCH = "https://www.youtube.com/watch?v="


async def formats(request: Request):
    """GET /api/formats?url=...: las resoluciones REALES que ofrece un video.

    Es lo que alimenta el picker: no se puede ofrecer 4K en un video que solo
    tiene 720p. Se valida con el parser de YouTube de siempre: cualquier cosa que
    no sea la URL de UN video (playlist, otro sitio) es 422, asi el endpoint no
    sirve de fetcher generico. El probe corre en un thread con cache de 5 min.
    """
    url = _query_str(request, "url", required=True, min_length=1, max_length=500)
    from .ytdlp_source import BotCheckError, parse_youtube_url, video_formats
    canonical = parse_youtube_url(url)
    if not canonical or not canonical.startswith(_YT_WATCH):
        raise _invalid(["query", "url"],
                       "Input should be a valid YouTube video URL")
    video_id = canonical[len(_YT_WATCH):]
    try:
        payload = await video_formats(canonical, video_id)
    except BotCheckError as e:
        # Mismo codigo que la descarga: la UI ofrece importar cookies.
        return JSONResponse({"detail": str(e), "code": e.code}, status_code=502)
    except Exception as e:
        log.warning("ytdlp formats fallo: %s", e)
        raise HTTPException(502, f"yt-dlp: {e}")
    return JSONResponse(payload)


async def download_warm(request: Request):
    """Adelanta la extraccion de yt-dlp de un video que probablemente se baje.

    La UI lo llama al abrir la ficha y con los primeros resultados. Contesta ya
    (202): la extraccion corre en background y `YtDlpSource.download` la
    reutiliza, asi la descarga se ahorra ~3 s. Solo acepta enlaces de VIDEO de
    YouTube: este endpoint no puede hacer que yt-dlp abra cualquier URL.
    204 si yt-dlp esta desactivado (no hay nada que adelantar).
    """
    from .ytdlp_source import parse_youtube_url, warm
    body = await _json_body(request)
    url = body.get("url")
    canon = parse_youtube_url(url) if isinstance(url, str) else None
    if not canon or "/watch?v=" not in canon:
        raise HTTPException(400, "url de video de YouTube invalida")
    ysrc = BY_NAME.get("ytdlp")
    if not ysrc or not ysrc.available():
        return Response(status_code=204)
    return JSONResponse({"warming": warm(canon)}, status_code=202)


async def stream_audio(request: Request):
    """GET /api/stream?url=...: proxy de bytes para el elemento <audio>.

    Igual que `/api/audio`, la peticion lleva la sesion del WebView (cookie del
    bootstrap con `?token=`), asi que el auth middleware no se toca. YouTube se
    pide siempre en trozos de 1 MiB: un rango abierto se corta o da 403.
    """
    url = _query_str(request, "url", required=True, min_length=1, max_length=500)
    from . import stream as stream_mod
    from .ytdlp_source import BotCheckError, parse_youtube_url
    canon = parse_youtube_url(url)
    if not canon or "/watch?v=" not in canon:
        raise HTTPException(400, "url de video de YouTube invalida")
    ysrc = BY_NAME.get("ytdlp")
    if not ysrc or not ysrc.available():
        return Response(status_code=204)
    vid = stream_mod.video_id(canon) or canon
    try:
        info = await stream_mod.resolve(canon)
    except BotCheckError as e:
        # Mismo codigo y mensaje que la descarga: la UI ofrece importar cookies.
        return JSONResponse({"detail": str(e), "code": e.code}, status_code=502)
    except Exception as e:
        log.warning("ytdlp stream fallo: %s", e)
        raise HTTPException(502, f"yt-dlp: {e}")

    rango = stream_mod.parse_range(request.headers.get("range"), info.filesize)
    if rango == "insatisfacible":
        headers = {"Accept-Ranges": "bytes"}
        if info.filesize is not None:
            headers["Content-Range"] = f"bytes */{info.filesize}"
        return Response(status_code=416, headers=headers)
    start, end, partial = rango

    cliente = stream_mod.client()
    up = stream_mod.Upstream(info, cliente, start, end)
    try:
        await up.open()
    except stream_mod.UpstreamGone:
        # La URL del formato vencio antes de mandar nada: se descarta y se
        # resuelve una sola vez mas. Despues del primer byte ya no se reintenta.
        stream_mod.drop(vid)
        try:
            info = await stream_mod.resolve(canon, force=True)
        except BotCheckError as e:
            return JSONResponse({"detail": str(e), "code": e.code}, status_code=502)
        except Exception as e:
            log.warning("ytdlp stream reintento fallo: %s", e)
            raise HTTPException(502, f"yt-dlp: {e}")
        up = stream_mod.Upstream(info, cliente, start, end)
        try:
            await up.open()
        except Exception as e:
            raise HTTPException(502, f"stream: {e}")
    except Exception as e:
        log.warning("stream upstream fallo: %s", e)
        raise HTTPException(502, f"stream: {e}")

    total = up.total
    headers = {"Accept-Ranges": "bytes"}
    if partial:
        last = end if end is not None else (total - 1 if total is not None else None)
        if last is not None and total is not None:
            last = min(last, total - 1)
        if total is not None and last is not None:
            headers["Content-Range"] = f"bytes {start}-{last}/{total}"
            headers["Content-Length"] = str(max(0, last - start + 1))
    elif total is not None:
        headers["Content-Length"] = str(total)
    return StreamingResponse(up.body(), status_code=206 if partial else 200,
                             media_type=info.mime, headers=headers)


async def stream_prepare(request: Request):
    """POST /api/stream/prepare: adelanta la resolucion, contesta 202 ya."""
    body = await _json_body(request)
    url = body.get("url")
    from .ytdlp_source import parse_youtube_url
    canon = parse_youtube_url(url) if isinstance(url, str) else None
    if not canon or "/watch?v=" not in canon:
        raise HTTPException(400, "url de video de YouTube invalida")
    ysrc = BY_NAME.get("ytdlp")
    if not ysrc or not ysrc.available():
        return Response(status_code=204)

    async def _bg():
        from . import stream as stream_mod
        try:
            await stream_mod.resolve(canon)
        except Exception as e:
            log.info("stream prepare fallo: %s", e)

    tarea = asyncio.create_task(_bg())
    BG_TASKS.add(tarea)
    tarea.add_done_callback(BG_TASKS.discard)
    return JSONResponse({"preparing": True}, status_code=202)


async def download(request: Request):
    query = _query_str(request, "query", default=None)
    wait = _query_bool(request, "wait", False)
    req = DownloadReq.from_body(await _json_body(request))

    src = BY_NAME.get(req.source)
    if not src:
        raise HTTPException(400, f"fuente desconocida: {req.source}")
    if not src.available():
        raise HTTPException(403, f"la fuente {req.source} esta desactivada")

    t = req.track  # dict crudo del body
    t.pop("downloadable", None)
    track = (TrackPayload.from_dict(t, ["body", "track"]).to_track()
             if "source" in t else None)
    if track is None:
        raise HTTPException(400, "payload de track invalido")

    # yt-dlp: su propio pipeline. Pasa por la cola GLOBAL (limite 2, dedupe,
    # cancelacion y reanudacion); por defecto devuelve job_id al toque y la UI
    # hace polling a /api/download/progress/{id}. Tambien entra aca lo que viene
    # del modo "matched" (source=itunes con webpage_url de YouTube): la ficha es
    # de iTunes pero el audio es de yt-dlp.
    if req.source == "ytdlp" or (
        req.source == "itunes" and track.extra.get("webpage_url")
    ):
        from .ytdlp_source import key_base_for
        if req.source == "itunes":
            # ficha canonica de iTunes: el nombre y los tags van de ahi, no
            # del titulo del video de YouTube
            track.extra["from_itunes"] = True
        ident = {
            "match": track.extra.get("match"),
            "match_label": track.extra.get("match_label"),
            "real_title": track.extra.get("real_title"),
            "real_artist": track.extra.get("real_artist"),
            "item_url": track.extra.get("webpage_url") or track.extra.get("item_url"),
        }
        ysrc = BY_NAME.get("ytdlp")
        if not ysrc or not ysrc.available():
            raise HTTPException(503, "yt-dlp está desactivado (YTDLP_ENABLED=1)")

        key_base = key_base_for(track, req.media, req.height)
        spec = {"source": req.source, "track": track.to_dict(), "fmt": req.fmt,
                "media": req.media, "height": req.height, "query": query,
                "key_base": key_base, "ident": ident}
        encolados = downloads.enqueue([spec])
        job_id = encolados[0]["id"]

        if wait:
            termino = await downloads.wait_item(job_id)
            if not termino:
                # Vencio el plazo de espera: el job SIGUE corriendo, no es un
                # error. Mismo contrato que sin wait=1: la UI sigue el
                # progreso por job_id en vez de colgarse esperando esta
                # respuesta para siempre.
                return JSONResponse({"ok": True, "source": "ytdlp",
                                     "job_id": job_id, **ident})
            item = downloads.get_item(job_id) or {}
            if item.get("error_code") == "youtube_bot_check":
                # Codigo propio: la UI ofrece importar un cookies.txt en vez de
                # un "fallo la descarga" generico.
                return JSONResponse({"detail": item.get("error") or "",
                                     "code": "youtube_bot_check"}, status_code=502)
            if item.get("status") == "error":
                raise HTTPException(502, f"yt-dlp: {item.get('error') or 'error'}")
            result = item.get("result") or {}
            return JSONResponse({"ok": True, "source": "ytdlp",
                                 "job_id": job_id, **ident, **result})

        return JSONResponse({"ok": True, "source": "ytdlp", "job_id": job_id,
                             **ident})

    # si la fuente necesita resolucion, hacerlo aqui (con la query para
    # poder leer los tags y decir si es lo que el usuario buscaba)
    with activity.busy():
        if not track.audio_url and track.extra.get("needs_resolve"):
            try:
                track = await src.resolve(track, query=query)
            except LookupError as e:
                raise HTTPException(404, str(e))
            except Exception as e:
                log.exception("resolve previo a descarga fallo")
                raise HTTPException(502, f"no se pudo resolver: {e}")

        if not track.audio_url:
            raise HTTPException(422, "esta pista no es descargable (solo preview)")

        try:
            result = await download_track(track, req.fmt)
            await asyncio.to_thread(
                link_saved_download, track.to_dict(), result.get("key"))
        except ValueError as e:
            raise HTTPException(422, str(e))
        except Exception as e:
            log.exception("descarga fallo")
            raise HTTPException(502, f"error descargando: {e}")

    # propagar la identidad verificada para que la UI pueda avisar
    return JSONResponse({
        "ok": True,
        "source": req.source,
        "match": track.extra.get("match"),
        "match_label": track.extra.get("match_label"),
        "real_title": track.extra.get("real_title"),
        "real_artist": track.extra.get("real_artist"),
        "item_url": track.extra.get("item_url"),
        **result,
    })


async def setlist(request: Request):
    """Resuelve varios items y dice que cancion hay REALMENTE en cada uno.

    Es lo que necesita la vista de concierto: los items de etree traen el
    nombre del show como titulo, asi que hay que leer los tags de cada pista
    para saber cuales son.
    """
    source_ids = _query_str(request, "source_ids", required=True)
    q = _query_str(request, "q", default="")
    src = BY_NAME.get("archive")
    ids = [i.strip() for i in source_ids.split(",") if i.strip()][:60]
    if not ids:
        return JSONResponse({"tracks": []})

    async def one(i: str) -> dict | None:
        t = Track(source="archive", source_id=i, title=q, artist="")
        try:
            r = await src.resolve(t, query=q or None)
        except Exception:
            return None
        d = r.to_dict()
        d["match"] = r.extra.get("match")
        d["match_label"] = r.extra.get("match_label")
        d["real_title"] = r.extra.get("real_title")
        d["real_artist"] = r.extra.get("real_artist")
        d["item_url"] = r.extra.get("item_url")
        d["filename"] = r.extra.get("filename")
        d["audio_url"] = r.audio_url
        d["format"] = r.extra.get("format")
        d["size_mb"] = r.extra.get("size_mb")
        d["duration_s"] = r.duration_s
        d["title_source"] = r.extra.get("title_source")
        d.pop("extra", None)
        return d

    res = await asyncio.gather(*(one(i) for i in ids))
    tracks = [r for r in res if r]
    # las que coinciden con la consulta primero
    order = {"match": 0, "partial": 1, "unknown": 2, "mismatch": 3}
    tracks.sort(key=lambda t: order.get(t.get("match") or "unknown", 2))
    return JSONResponse({"tracks": tracks})


async def _fileinfo_records(storage) -> dict:
    """Veredictos guardados. Si no se pueden leer, la lista sale sin ellos."""
    try:
        return await run_storage(storage.load_fileinfo)
    except Exception as e:
        log.warning("no se pudieron leer los veredictos: %s", e)
        return {}


def _dumps_json(content: Any) -> bytes:
    """Mismos parametros que `JSONResponse.render` (Starlette), para que un
    payload serializado en un thread sea byte-por-byte lo mismo que uno hecho
    en el loop."""
    return json.dumps(content, ensure_ascii=False, allow_nan=False, indent=None,
                      separators=(",", ":")).encode("utf-8")


async def _json_response_threaded(content: Any, *, status_code: int = 200) -> Response:
    """Como `JSONResponse(content)`, pero el `json.dumps` corre en el pool de
    storage: docs/performance.md midio 1,15 MB para 3000 pistas, que en el
    telefono son decenas de ms bloqueando el loop si se serializa inline.
    """
    body = await run_storage(_dumps_json, content)
    return Response(body, status_code=status_code, media_type="application/json")


#: Columnas de la forma compacta de `/api/library` (P-large-library-scale-1,
#: P-large-library-scale-8). El array de objetos repite cada nombre de campo
#: en cada fila; a 20k pistas eso es la mayor parte de los ~7.7 MB del cuerpo.
#: En columnas el nombre de cada campo sale UNA vez y las filas son arrays sin
#: etiqueta. `size_mb` no viaja: se recalcula de `bytes` al expandir, es
#: redundante. El orden importa (lo usa el frontend para expandir) y el
#: frontend lo espera tal cual: cambiarlo es un cambio de contrato.
COMPACT_FIELDS = (
    "key", "filename", "folder", "bytes", "duration_s", "title", "artist",
    "album", "track_no", "disc_no", "album_id", "modified", "kind",
    "thumb_key", "has_audio", "thumb_s", "verdict", "meta_src", "file_src",
    "real",
)


def _compact_rows(files: list[dict]) -> list[list]:
    """Las mismas filas de `library_scan`/`with_checks`, en columnas."""
    return [[f.get(name) for name in COMPACT_FIELDS] for f in files]


def _library_body(describe, files: list, compact: bool) -> tuple[bytes, str]:
    """JSON de `/api/library` y su ETag. Corre en un hilo: con miles de
    pistas son cerca de un megabyte que no se serializa en el loop."""
    payload = {"library": describe, "count": len(files)}
    if compact:
        payload["fields"] = COMPACT_FIELDS
        payload["rows"] = _compact_rows(files)
    else:
        payload["files"] = files
    body = json.dumps(payload, ensure_ascii=False,
                      separators=(",", ":")).encode("utf-8")
    return body, _library_etag(body)


def _library_etag(body: bytes) -> str:
    """ETag debil del cuerpo de `/api/library`: mismos bytes, mismo ETag."""
    return f'W/"{hashlib.sha256(body).hexdigest()[:32]}"'


#: `no-cache` NO es "no cachear": le dice al navegador que SI guarde la
#: respuesta pero revalide siempre con el server antes de usarla. Con eso,
#: `fetch()` (modo "default", el que ya usa el frontend) manda `If-None-Match`
#: solo porque el navegador ya tiene una copia, y un 304 se lo sirve de la
#: cache local sin que el codigo de la UI note la diferencia.
_LIBRARY_CACHE = {"Cache-Control": "private, no-cache"}


async def library(request: Request):
    """GET /api/library. Con `If-None-Match` vigente, 304 sin cuerpo: evita
    mandar (y que el navegador vuelva a parsear) el JSON entero cuando nada
    cambio desde el ultimo pedido (P-large-library-scale-8, P-network-caching-6).

    `?shape=compact` pide las filas en columnas en vez de un objeto por
    archivo (ver COMPACT_FIELDS): un frontend viejo nunca manda el parametro y
    sigue recibiendo `files` como siempre; uno nuevo contra un backend viejo
    (que ignora el parametro desconocido) tambien sigue andando, solo que sin
    la columna. Las dos formas quedan bajo URLs distintas, asi que el cache
    HTTP (ETag) de cada una es independiente.
    """
    storage = get_storage()
    compact = request.query_params.get("shape") == "compact"
    files, records = await asyncio.gather(
        run_storage(library_scan), _fileinfo_records(storage))
    files = with_checks(files, records)
    # Serializar en el pool de storage (no en el loop) y, ademas, responder 304
    # si el cliente ya tiene el mismo cuerpo (ETag debil).
    body, etag = await run_storage(_library_body, storage.describe(), files,
                                   compact)
    headers = {**_LIBRARY_CACHE, "ETag": etag}
    if_none_match = request.headers.get("if-none-match")
    if if_none_match and etag in [v.strip() for v in if_none_match.split(",")]:
        return Response(status_code=304, headers=headers)
    return Response(body, media_type="application/json", headers=headers)


# ------------------------------------------------------------ borrado en libro
#: Limite del pedido: una lista enorme no debe bloquear el hilo de storage.
MAX_DELETE_KEYS = 500
#: Solo se borran temas y videos. Las miniaturas van con su media y un .txt
#: que se cuela en la biblioteca nunca es una clave de este endpoint.
_DELETE_EXTS = frozenset(e.lower() for e in (*AUDIO_EXTS, *VIDEO_EXTS))


def _media_stem(key: str) -> str:
    """Tronco comun de audio y video (`A/Tema.mp3`, `A/Tema.mp4` -> `A/Tema`)."""
    return _thumb_sidecar(key)[: -len(".jpg")]


def _validate_delete_keys(body: dict) -> list[str]:
    """Claves del pedido, validadas contra el puerto y limitadas a media."""
    keys = body.get("keys")
    if not isinstance(keys, list):
        raise _invalid(["body", "keys"], "las claves tienen que ser una lista")
    if not keys:
        raise _invalid(["body", "keys"], "la lista de claves no puede estar vacia")
    if len(keys) > MAX_DELETE_KEYS:
        raise _invalid(["body", "keys"],
                       f"como maximo {MAX_DELETE_KEYS} claves por pedido")
    out: list[str] = []
    for key in keys:
        try:
            validate_key(key)
        except InvalidKey as exc:
            raise _invalid(["body", "keys"], str(exc))
        if os.path.splitext(key)[1].lower() not in _DELETE_EXTS:
            raise _invalid(["body", "keys"], "extension no permitida")
        if key not in out:
            out.append(key)
    return out


def _playlists_hold(storage, keys: set[str]) -> bool:
    """True si alguna lista viva tiene alguna de las claves (o no se sabe)."""
    try:
        book = storage.load_playlists()
    except Exception:
        return True  # que lo intente save_playlist, como antes
    return any(not p.deleted and keys & set(p.keys)
               for p in book.playlists.values())


def _drop_playlist_keys(storage, keys: set[str], now: float,
                        rewrite: dict[str, str] | None = None) -> None:
    """Saca claves o ids borrados de las listas vivas que los tengan.

    `rewrite` son claves de archivo que siguen vivas como canciones guardadas:
    se cambian por su id en vez de sacarlas. Todo lo que suena desde una lista
    esta en la biblioteca: si se borra el archivo o se quita la cancion, la
    entrada no puede quedar colgada. Reescribir cuesta una subida en la nube,
    solo se hace si alguna lista tenia algo. Un fallo aqui no invalida el
    borrado principal.
    """
    rewrite = rewrite or {}
    touched = set(keys) | set(rewrite)
    if not touched or not _playlists_hold(storage, touched):
        return

    def change(book) -> None:
        # Las listas quedan, aunque se queden sin ninguna cancion.
        for pid, playlist in list(book.playlists.items()):
            if playlist.deleted or not (touched & set(playlist.keys)):
                continue
            kept: list[str] = []
            for key in playlist.keys:
                if key in rewrite:
                    sid = rewrite[key]
                    if sid not in kept:  # la lista ya podia tener el id
                        kept.append(sid)
                elif key not in keys:
                    kept.append(key)
            if rewrite:
                # La lista ya podia tener el id y la clave del archivo.
                kept = list(dict.fromkeys(kept))
            book.upsert(replace(
                playlist,
                keys=kept,
                updated_at=_next_updated_at(playlist, now),
            ))

    try:
        storage.save_playlist(change)
    except Exception as exc:
        log.warning("no se pudieron limpiar las listas tras borrar: %s", exc)


def _delete_library_files(storage, keys: list[str],
                          removed: list[str] | None = None,
                          ) -> tuple[list[str], list[dict]]:
    """Borra archivos, portadas huerfanas y referencias en playlists.

    Sincrono y con el storage pegado: se llama desde `asyncio.to_thread`. Un
    fallo de un archivo no cancela los demas: se devuelve en `failed`. Si se
    pasa `removed`, recibe TODAS las claves que desaparecieron, portadas
    incluidas (Android las saca del MediaStore).
    """
    gone = set(keys)
    # Un audio y su video comparten portada: si sobrevive cualquiera de los dos,
    # los sidecars se quedan. Se mira ANTES de borrar, con una sola lista.
    stems = {_media_stem(f.key) for f in storage.list()
             if f.key not in gone
             and os.path.splitext(f.key)[1].lower() in _DELETE_EXTS}

    # Todo en UNA llamada, con UNA escritura del indice en la nube. Las portadas
    # van como seguidoras de su tema: si el tema falla, se quedan con el.
    sides_of = {key: [_thumb_sidecar(key), thumb_small_sidecar(key)]
                for key in keys if _media_stem(key) not in stems}
    try:
        errors = storage.delete_files(keys, sides_of)
    except Exception as exc:
        # La escritura del indice fallo: nada se da por borrado.
        errors = {key: exc for key in keys}
    deleted: list[str] = []
    failed: list[dict] = []
    for key in keys:
        exc = errors.get(key)
        if exc is not None and not isinstance(exc, FileNotFoundError):
            log.warning("no se pudo borrar '%s': %s", key, exc)
            failed.append({"key": key, "error": str(exc)})
            continue
        deleted.append(key)  # FileNotFoundError: ya no estaba, da lo mismo
        if removed is not None:
            removed.append(key)
        for side in sides_of.get(key, ()):
            side_exc = errors.get(side)
            if side_exc is None:
                if removed is not None:
                    removed.append(side)
            elif not isinstance(side_exc, FileNotFoundError):
                log.warning("no se pudo borrar la portada '%s': %s", side, side_exc)

    borradas = set(deleted)
    # Un archivo borrado puede ser la descarga de una cancion guardada: la
    # cancion sigue en la biblioteca, asi que se desvincula y las listas pasan
    # a referir el id en vez de la clave del archivo.
    rewrite: dict[str, str] = {}
    clears: dict[str, SavedSong] = {}
    if borradas:
        try:
            saved_book = storage.load_saved()
        except Exception as exc:
            log.warning("no se pudo leer guardadas tras borrar: %s", exc)
            saved_book = None
        if saved_book is not None:
            for song in saved_book.live():
                if song.file_key in borradas:
                    clears[song.id] = song
                    rewrite[song.file_key] = song.id
            if clears:
                def change_saved(book: SavedBook) -> None:
                    for sid, song in clears.items():
                        current = book.songs.get(sid)
                        if (current is None or current.deleted
                                or current.file_key not in borradas):
                            continue
                        book.upsert(replace(
                            current, file_key=None,
                            updated_at=_next_saved_updated_at(current, now)))

                now = time.time()
                try:
                    # UNA sola escritura para todas las canciones del lote.
                    storage.save_saved(change_saved)
                except Exception as exc:
                    log.warning("no se pudo desvincular guardadas tras borrar: %s", exc)
                    clears.clear()
                    rewrite.clear()
    _drop_playlist_keys(storage, borradas, time.time(), rewrite)
    if deleted:
        # El adapter local guarda duraciones y etiquetas por clave: sacarlas
        # evita que un listado posterior "recuerde" un archivo ya borrado.
        forget = getattr(storage, "forget_media", None)
        if callable(forget):
            try:
                forget(deleted)
            except Exception as exc:
                log.warning("no se pudo limpiar la cache de media: %s", exc)
    return deleted, failed


async def library_delete(request: Request):
    """POST /api/library/delete: borra temas/videos de la biblioteca.

    200 aunque fallen algunos (`failed`); el frontend decide que filas vuelve
    a mostrar. `activity.removed` le pasa a Android las claves borradas para
    que las saque del MediaStore.
    """
    body = await _json_body(request)
    keys = _validate_delete_keys(body)
    storage = get_storage()
    gone: list[str] = []
    deleted, failed = await asyncio.to_thread(
        _delete_library_files, storage, keys, gone)
    activity.removed(gone)
    if deleted:
        # Discover guarda un escaneo de la biblioteca: sin esto seguiria
        # recomendando la cancion borrada hasta que venciera la cache.
        _forget_cached("scan", storage=storage)
    return JSONResponse({"deleted": deleted, "failed": failed})


# ---------------------------------------------------------------- playlists
def _playlist_payload(playlist: Playlist) -> dict:
    """Forma JSON de una playlist (la que consume el frontend)."""
    return {"id": playlist.id, "name": playlist.name,
            "keys": list(playlist.keys), "updated_at": playlist.updated_at}


def _next_updated_at(old: Playlist | None, now: float) -> float:
    """`updated_at` nuevo, SIEMPRE mayor que el guardado.

    El reloj del dispositivo puede retroceder (ajuste de hora, cambio de
    zona): sin esto una edicion nueva perderia el merge contra su propia copia
    vieja y el cambio no se veria en ningun lado.
    """
    if old is None:
        return now
    return max(now, old.updated_at + 0.001)


async def playlists(request: Request):
    """GET /api/playlists: solo las vigentes, ordenadas por nombre."""
    book = await asyncio.to_thread(get_storage().load_playlists)
    return JSONResponse({"playlists": [_playlist_payload(p)
                                       for p in book.live()]})


async def playlist_save(request: Request):
    """PUT /api/playlists/{id}: crea o reemplaza (200 con la playlist)."""
    storage = get_storage()
    playlist_id = request.path_params["id"]
    body = await _json_body(request)
    try:
        name, keys = validate_playlist(playlist_id, body.get("name"),
                                       body.get("keys"))
    except ValueError as exc:
        raise _invalid(["body"], str(exc))

    def _save() -> Playlist:
        # `load_playlists()` es la vista MERGEADA: el `updated_at` tiene que
        # superar al de todos los dispositivos, no solo al del libro propio.
        book = storage.load_playlists()
        old = book.playlists.get(playlist_id)
        playlist = Playlist(id=playlist_id, name=name, keys=keys,
                            updated_at=_next_updated_at(old, time.time()))
        storage.save_playlist(lambda b: b.upsert(playlist))
        return playlist

    playlist = await asyncio.to_thread(_save)
    return JSONResponse(_playlist_payload(playlist))


async def playlist_delete(request: Request):
    """DELETE /api/playlists/{id}: tombstone (204 tambien si no existia)."""
    storage = get_storage()
    playlist_id = request.path_params["id"]

    def _delete() -> None:
        book = storage.load_playlists()
        old = book.playlists.get(playlist_id)
        storage.save_playlist(
            lambda b: b.remove(playlist_id, _next_updated_at(old, time.time())))

    await asyncio.to_thread(_delete)
    return Response(status_code=204)


# ------------------------------------------------------------ canciones guardadas
def _saved_payload(song: SavedSong) -> dict:
    """Forma JSON de una cancion guardada (la que consume el frontend)."""
    return {"id": song.id, "title": song.title, "artist": song.artist,
            "album": song.album, "duration": song.duration,
            "artwork_url": song.artwork_url, "source": song.source,
            "source_id": song.source_id, "itunes": dict(song.itunes),
            "file_key": song.file_key, "added_at": song.added_at,
            "updated_at": song.updated_at}


def _next_saved_updated_at(old: SavedSong | None, now: float) -> float:
    """`updated_at` nuevo, SIEMPRE mayor que el guardado (como en playlists)."""
    if old is None:
        return now
    return max(now, old.updated_at + 0.001)


def _saved_list_payload(book: SavedBook) -> dict:
    return {"songs": [_saved_payload(s) for s in book.live()]}


#: Ids de iTunes que puede traer el track de una descarga en `extra`. La
#: cancion guardada a veces se creo desde YouTube (sin ellos) o antes de que
#: existiera el match: al bajarla se completan los que falten.
_SAVED_ITUNES_FIELDS = {
    "track_id": ("track_id", "trackId"),
    "collection_id": ("collection_id", "collectionId"),
    "artist_id": ("artist_id", "artistId"),
    "track_no": ("track_no", "track_number", "trackNumber"),
    "disc_no": ("disc_no", "disc_number", "discNumber"),
    "track_count": ("track_count", "trackCount"),
}


def _saved_itunes_ids(track: dict) -> dict:
    """Los ids enteros de iTunes del track de una descarga, si los trae."""
    extra = track.get("extra")
    if not isinstance(extra, dict):
        return {}
    out = {}
    for clave, nombres in _SAVED_ITUNES_FIELDS.items():
        for nombre in nombres:
            valor = extra.get(nombre)
            if isinstance(valor, int) and not isinstance(valor, bool):
                out[clave] = valor
                break
    return out


def link_saved_download(track: dict, key: str | None) -> bool:
    """Enlaza una descarga terminada con su cancion guardada, si la hay.

    Sincrono y con el storage pegado: lo llama la cola desde un hilo. Una sola
    escritura del registro, solo si la cancion sigue viva y no apuntaba ya a
    esta clave. Aprovecha para completar los ids de iTunes que falten (con
    `artist_id` el nombre del artista abre su pagina en vez de buscarlo).
    Los registros viejos sin ids siguen funcionando igual. Un fallo aqui no
    invalida la descarga.
    """
    if not isinstance(key, str) or not key:
        return False
    sid = song_id_for_track(track)
    if not sid:
        return False
    storage = get_storage()
    now = time.time()
    try:
        old = storage.load_saved().songs.get(sid)
    except Exception as exc:
        log.warning("no se pudo leer guardadas para enlazar '%s': %s", key, exc)
        return False
    if old is None or old.deleted or old.file_key == key:
        return False
    itunes_ids = _saved_itunes_ids(track)

    def change(book: SavedBook) -> None:
        current = book.songs.get(sid)
        if current is None or current.deleted or current.file_key == key:
            return
        # Solo lo que falta: un id ya guardado no se sobrescribe.
        falta = {k: v for k, v in itunes_ids.items() if k not in current.itunes}
        itunes = {**current.itunes, **falta} if falta else current.itunes
        book.upsert(replace(current, file_key=key, itunes=itunes,
                            updated_at=_next_saved_updated_at(current, now)))

    try:
        storage.save_saved(change)
    except Exception as exc:
        log.warning("no se pudo enlazar '%s' con guardadas: %s", key, exc)
        return False
    return True


async def saved_list(request: Request):
    """GET /api/saved: las vigentes, de la mas reciente a la mas vieja."""
    book = await asyncio.to_thread(get_storage().load_saved)
    return JSONResponse(_saved_list_payload(book))


async def saved_save(request: Request):
    """PUT /api/saved: upsert de un lote (fechas puestas por el servidor)."""
    storage = get_storage()
    body = await _json_body(request)
    try:
        records = validate_saved_payload(body)
    except ValueError as exc:
        raise _invalid(["body"], str(exc))

    def _save() -> dict:
        book = storage.load_saved()
        now = time.time()
        built: list[SavedSong] = []
        for rec in records:
            old = book.songs.get(rec["id"])
            # Volver a guardar algo quitado cuenta como nuevo: vuelve arriba de
            # "Añadido hace poco".
            kept = old is not None and not old.deleted
            built.append(SavedSong(
                **rec, added_at=old.added_at if kept else now,
                updated_at=_next_saved_updated_at(old, now)))

        def change(b: SavedBook) -> None:
            for song in built:
                b.upsert(song)

        return _saved_list_payload(storage.save_saved(change))

    return JSONResponse(await asyncio.to_thread(_save))


async def saved_remove(request: Request):
    """POST /api/saved/remove: tombstone de las ids dadas."""
    storage = get_storage()
    body = await _json_body(request)
    ids = body.get("ids")
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
        raise _invalid(["body", "ids"], "ids tiene que ser una lista de textos")
    if len(ids) > MAX_SONGS:
        raise _invalid(["body", "ids"], "demasiadas canciones por request")
    try:
        for sid in ids:
            validate_song_id(sid)
    except ValueError as exc:
        raise _invalid(["body", "ids"], str(exc))

    def _remove() -> dict:
        now = time.time()

        def change(b: SavedBook) -> None:
            for sid in ids:
                old = b.songs.get(sid)
                b.remove(sid, _next_saved_updated_at(old, now))

        result = _saved_list_payload(storage.save_saved(change))
        # Una cancion quitada no puede seguir en una lista: ya no estaria en
        # la biblioteca y la fila no se podria resolver.
        _drop_playlist_keys(storage, set(ids), now)
        return result

    return JSONResponse(await asyncio.to_thread(_remove))


# ------------------------------------------------ imagenes personalizadas (ADR 0005)
#: Timeouts y saltos de la bajada de imagenes, los mismos que `covers.py`.
ART_TIMEOUT_S = 5.0
ART_MAX_HOPS = 2


class ArtFetchError(Exception):
    """Fallo al bajar una imagen: `status` y `detail` ya son de la API."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _art_client() -> httpx.AsyncClient:
    """Cliente HTTP de las imagenes. Los tests lo cambian por un MockTransport."""
    return httpx.AsyncClient(timeout=httpx.Timeout(ART_TIMEOUT_S),
                             follow_redirects=False,
                             headers={"User-Agent": USER_AGENT})


async def _art_get(client: httpx.AsyncClient, url: str, source: str) -> bytes:
    """Baja un JPG de la lista, sin seguir redirecciones fuera de ella."""
    for _ in range(ART_MAX_HOPS + 1):
        try:
            resp = await client.get(url)
        except httpx.HTTPError as exc:
            raise ArtFetchError(
                502, f"no se pudo bajar la imagen: {exc}") from exc
        if resp.is_redirect:
            target = urljoin(url, resp.headers.get("location", ""))
            try:
                validate_art_url(target, source)
            except ValueError as exc:
                raise ArtFetchError(
                    422, "redireccion fuera de la lista") from exc
            url = target
            continue
        if resp.status_code >= 400:
            raise ArtFetchError(502, "la imagen no esta disponible")
        try:
            return validate_image(resp.content, MAX_IMAGE_BYTES, "url")
        except ValueError as exc:
            raise ArtFetchError(422, str(exc)) from exc
    raise ArtFetchError(422, "demasiadas redirecciones")


async def _fetch_art_images(source: str, url: str) -> tuple[bytes, bytes]:
    """`(grande, chica)`. mzstatic reescala por URL; en las otras fuentes no
    hay libreria de imagenes (Android), asi que usamos los mismos bytes.
    """
    if source == SOURCE_ITUNES:
        variants = mzstatic_variants(url)
        if variants is None:
            raise ArtFetchError(422, "la url de iTunes no es una portada jpg")
        big_url, small_url = variants
    else:
        big_url = small_url = url
    async with _art_client() as client:
        return await asyncio.gather(_art_get(client, big_url, source),
                                    _art_get(client, small_url, source))


def _art_target(body: dict) -> str:
    try:
        return validate_target(body.get("target"))
    except ValueError as exc:
        raise _invalid(["body", "target"], str(exc)) from exc


def _art_image(body: dict, field: str, limit: int) -> bytes:
    """Decodifica base64 y valida el JPG. Errores 422 como el resto de la API."""
    value = body.get(field)
    if not isinstance(value, str) or not value:
        raise _invalid(["body", field], "Field required")
    try:
        data = base64.b64decode(value, validate=True)
    except ValueError as exc:
        raise _invalid(["body", field], "base64 invalido") from exc
    try:
        return validate_image(data, limit, field)
    except ValueError as exc:
        raise _invalid(["body", field], str(exc)) from exc


def _next_art_updated_at(old: ArtRecord | None, now: float) -> float:
    """`updated_at` nuevo, SIEMPRE mayor que el guardado (como saved)."""
    if old is None or old.deleted:
        return now
    return max(now, old.updated_at + 0.001)


def _art_payload(record: ArtRecord) -> dict:
    """Lo que consume el frontend: solo claves y procedencia."""
    return {"key": record.key, "small_key": record.small_key,
            "source": record.source}


def _art_map(book) -> dict:
    return {"art": {r.target: _art_payload(r) for r in book.live()}}


def _store_art(storage, target: str, big: bytes, small: bytes,
               source: str) -> ArtRecord:
    """Escribe los dos JPG content-addressed y upserta el registro. Sincrono.

    La misma imagen da siempre la misma clave, asi que dos dispositivos no
    pueden chocar y un re-upload no vuelve a escribir nada.
    """
    big_key, small_key = art_keys(hashlib.sha256(big).hexdigest())
    try:
        # `allow_force=False`: el hash del contenido es casi siempre NUEVO
        # (dos imagenes iguales byte a byte son raras), asi que forzar una
        # relectura completa del indice por cada subida de imagen es puro
        # desperdicio (P-drive-io-8). Si otro dispositivo subio la MISMA
        # imagen hace instantes y la vista en memoria todavia no lo sabe, en
        # el peor caso se vuelve a subir el mismo contenido: no se pierde ni
        # se corrompe nada.
        storage.stat(big_key, allow_force=False)
        storage.stat(small_key, allow_force=False)
        exists = True
    except (FileNotFoundError, OSError):
        exists = False
    if not exists:
        work = Path(tempfile.mkdtemp())
        try:
            big_path, small_path = work / "big.jpg", work / "small.jpg"
            big_path.write_bytes(big)
            small_path.write_bytes(small)
            storage.put_files([(big_key, big_path), (small_key, small_path)])
        finally:
            shutil.rmtree(work, ignore_errors=True)
    now = time.time()

    def change(book) -> None:
        old = book.records.get(target)
        book.upsert(ArtRecord(target=target, key=big_key,
                              small_key=small_key, source=source,
                              updated_at=_next_art_updated_at(old, now)))

    return storage.save_art(change).records[target]


async def art_list(request: Request):
    """GET /api/art: imagenes vigentes por objetivo."""
    book = await asyncio.to_thread(get_storage().load_art)
    return JSONResponse(_art_map(book))


async def art_upload(request: Request):
    """POST /api/art/upload {target, image, small}: JPGs ya reescalados."""
    body = await _json_body(request)
    target = _art_target(body)
    image = _art_image(body, "image", MAX_IMAGE_BYTES)
    small = _art_image(body, "small", MAX_SMALL_BYTES)

    def _work() -> dict:
        record = _store_art(get_storage(), target, image, small, SOURCE_UPLOAD)
        return {"target": target, **_art_payload(record)}

    return JSONResponse(await asyncio.to_thread(_work))


async def art_from_url(request: Request):
    """POST /api/art/from-url {target, url, source}: baja la imagen permitida."""
    body = await _json_body(request)
    target = _art_target(body)
    try:
        source = validate_source(body.get("source"))
        url = validate_art_url(body.get("url"), source)
    except ValueError as exc:
        raise _invalid(["body"], str(exc)) from exc
    try:
        big, small = await _fetch_art_images(source, url)
    except ArtFetchError as exc:
        raise HTTPException(exc.status, exc.detail) from exc

    def _work() -> dict:
        record = _store_art(get_storage(), target, big, small, source)
        return {"target": target, **_art_payload(record)}

    return JSONResponse(await asyncio.to_thread(_work))


async def art_reset(request: Request):
    """POST /api/art/reset {target}: tombstone. Las imagenes se quedan."""
    body = await _json_body(request)
    target = _art_target(body)

    def _work() -> dict:
        storage = get_storage()
        now = time.time()

        def change(book) -> None:
            old = book.records.get(target)
            book.remove(target, _next_art_updated_at(old, now))

        return _art_map(storage.save_art(change))

    return JSONResponse(await asyncio.to_thread(_work))


# ------------------------------------------------------------------ listens
async def listens_append(request: Request):
    """POST /api/listens: agrega eventos de ESTE dispositivo.

    El `dev` lo pone el storage, no el cliente. Devuelve cuantos se aceptaron
    para que el frontend sepa que puede soltar su lote.
    """
    body = await _json_body(request)
    try:
        events = validate_events(body.get("events"))
    except ValueError as exc:
        raise _invalid(["body", "events"], str(exc))

    accepted = await asyncio.to_thread(get_storage().append_listens, events)
    return JSONResponse({"ok": True, "accepted": accepted})


async def listens_summary(request: Request):
    """GET /api/listens/summary: merge de todos los dispositivos.

    Por la misma cache de 30 s que ya usa Discover (`_cached_summary`): sin
    esto, esta ruta releia todo de nuevo en cada apertura de la pestana de
    historial aunque Discover ya lo tuviera fresco (P-drive-io-7).
    """
    storage = get_storage()
    data = await asyncio.to_thread(_cached_summary, storage)
    return JSONResponse(data)


# ------------------------------------------------------- recomendaciones (Discover)
# Un solo enricher por proceso: el hilo y los contadores son del proceso, no de
# la request. Se crea la primera vez que se pide Discover y los tests lo pisan.
_enricher: Enricher | None = None
_enricher_lock = threading.Lock()

#: Cuanto viven en memoria la biblioteca escaneada y el resumen de escucha.
#: La UI de Discover pollea cada pocos segundos y en Drive cada lectura cuesta
#: ~2 s: sin esto, cada GET vuelve a bajar todo. El libro de descartes no vence
#: solo (el descarte lo actualiza en el acto) y las fichas salen del enricher si
#: las tiene. Un valor vencido NO bloquea: se devuelve tal cual y se refresca en
#: un thread aparte (stale-while-revalidate); solo la primera lectura, sin nada
#: cacheado, espera a la nube.
DISCOVER_CACHE_SECONDS = 30.0
_cache_lock = threading.Lock()
_cache_owner: object = None
_cache_values: dict[str, object] = {}
_cache_stamps: dict[str, float] = {}
_cache_epoch = 0
# Refresco en segundo plano de lo vencido: un solo thread a la vez, que va
# sacando de la cola `clave -> (loader, storage)`.
_refresh_queue: dict[str, tuple[object, object]] = {}
_refresh_running: str | None = None
_refresh_thread: threading.Thread | None = None
_discover_pool: ThreadPoolExecutor | None = None
_discover_pool_lock = threading.Lock()


def _cache_use_owner(storage: object) -> None:
    """`_cache_*` es del adapter activo: si cambio, se tira todo."""
    global _cache_owner
    if _cache_owner is not storage:
        _cache_values.clear()
        _cache_stamps.clear()
        _cache_owner = storage


def _cached(key: str, loader, *, storage, ttl: float | None,
            stale_ok: bool = True):
    """Valor de `loader()` cacheado por `ttl` segundos (`None` = no vence).

    Vencido, se devuelve igual y se refresca aparte; con `stale_ok=False` se
    vuelve a leer en el acto (el enricher no puede trabajar con fichas viejas).
    """
    now = time.monotonic()
    with _cache_lock:
        _cache_use_owner(storage)
        stamp = _cache_stamps.get(key)
        expired = (stamp is not None and ttl is not None
                   and now - stamp >= ttl)
        if stamp is not None and (stale_ok or not expired):
            if expired:
                # Vencido pero con valor: se contesta ya y se refresca aparte.
                _schedule_refresh(key, loader, storage)
            return _cache_values[key]
        epoch = _cache_epoch
    value = loader()
    with _cache_lock:
        _cache_use_owner(storage)
        # Si mientras calculabamos alguien invalido la cache, no se repone.
        if epoch == _cache_epoch:
            _cache_values[key] = value
            _cache_stamps[key] = now
    return value


def _schedule_refresh(key: str, loader, storage: object) -> None:
    """Encola el refresco de `key` (con `_cache_lock` tomado). Una vez por clave."""
    global _refresh_thread
    if key in _refresh_queue or key == _refresh_running:
        return
    _refresh_queue[key] = (loader, storage)
    if _refresh_thread is None:
        _refresh_thread = threading.Thread(
            target=_refresh_worker, name="discover-refresh", daemon=True)
        _refresh_thread.start()


def _refresh_worker() -> None:
    """Vacia la cola de refrescos de a uno; al terminar, el thread se retira."""
    global _refresh_thread, _refresh_running
    while True:
        with _cache_lock:
            if not _refresh_queue:
                _refresh_thread = None
                return
            key = next(iter(_refresh_queue))
            loader, storage = _refresh_queue.pop(key)
            if _cache_owner is not storage:
                continue  # el adapter cambio: ese valor ya no importa
            _refresh_running = key
            epoch = _cache_epoch
        started = time.monotonic()
        try:
            value = loader()
            ok = True
        except Exception as exc:
            # Sin red o la nube caida: se sigue sirviendo lo viejo y el
            # proximo GET lo vuelve a intentar.
            log.warning("no se pudo refrescar '%s' de Discover: %s", key, exc)
            value, ok = None, False
        with _cache_lock:
            _refresh_running = None
            # Si mientras tanto alguien invalido la cache, no se repone.
            if ok and _cache_owner is storage and epoch == _cache_epoch:
                _cache_values[key] = value
                _cache_stamps[key] = started


def _apply_dismissal(storage: object, name: str, undo: bool) -> None:
    """Refleja un descarte en el set cacheado, sin releer la nube.

    El descarte siempre le gana al merge de los demas dispositivos (`at` crece
    por encima de lo que ya habia), asi que aplicarlo a mano da el mismo set
    que releerlo. Sube el epoch: una lectura en vuelo anterior no lo pisa.
    """
    global _cache_epoch
    with _cache_lock:
        if _cache_owner is not storage:
            return
        _cache_epoch += 1
        current = _cache_values.get("discover")
        if current is None:
            return
        updated = set(current)
        if undo:
            updated.discard(fold(name))
        else:
            updated.add(fold(name))
        _cache_values["discover"] = updated


def _forget_cached(key: str, storage: object | None = None) -> None:
    """Olvida una entrada (los descartes cambian con cada POST)."""
    global _cache_epoch
    with _cache_lock:
        if storage is not None and _cache_owner is not storage:
            return
        # Una lectura en vuelo que empezo antes de esto no debe reponer el
        # valor viejo: el epoch la descarta al guardar.
        _cache_epoch += 1
        _cache_values.pop(key, None)
        _cache_stamps.pop(key, None)


def _discover_records(storage, enricher) -> dict:
    """Fichas de artista: las del enricher si ya las tiene, si no las del storage."""
    snapshot = getattr(enricher, "records", None)
    if callable(snapshot):
        try:
            records = snapshot()
        except Exception as exc:
            log.warning("no se pudo leer el artistinfo del enricher: %s", exc)
            records = None
        if isinstance(records, dict):
            return records
    return _cached_records(storage)


# Las entradas de Discover, compartidas por la request y el enricher: el hilo
# arranca justo despues del primer GET y asi no relista lo que este acaba de
# leer. El enricher las pide frescas (`stale_ok=False`).
def _cached_records(storage, stale_ok: bool = True) -> dict:
    return _cached("artistinfo", storage.load_artistinfo, storage=storage,
                   ttl=DISCOVER_CACHE_SECONDS, stale_ok=stale_ok)


def _cached_summary(storage, stale_ok: bool = True) -> dict:
    return _cached("listens", storage.load_listens_summary, storage=storage,
                   ttl=DISCOVER_CACHE_SECONDS, stale_ok=stale_ok) or {}


def _cached_tracks(storage, stale_ok: bool = True) -> dict:
    return _cached_summary(storage, stale_ok).get("tracks", {})


def _discover_saved(storage) -> SavedBook:
    """Una sola lectura del registro de guardadas: el adapter lo cachea."""
    try:
        return storage.load_saved()
    except Exception as exc:
        log.warning("no se pudieron leer las canciones guardadas: %s", exc)
        return SavedBook()


def _discover_entries(storage) -> list[dict]:
    """Escaneo de archivos mas guardadas sin archivo, en UNA sola tarea.

    El listado del indice y el del registro comparten el lock del storage, asi
    que van juntos: cuatro entradas en paralelo, no cinco esperando el lock.
    """
    from .recommend import saved_entries
    files = library_scan()
    return list(files) + saved_entries(
        _discover_saved(storage),
        [entry.get("key") for entry in files if isinstance(entry, dict)])


def _cached_dismissed(storage) -> set[str]:
    # No vence: cada descarte lo actualiza en el acto (`_apply_dismissal`).
    return _cached("discover", lambda: storage.load_discover().dismissed_set(),
                   storage=storage, ttl=None)


def _discover_loader_pool() -> ThreadPoolExecutor:
    """Threads para las cuatro entradas de Discover: se crean una sola vez."""
    global _discover_pool
    with _discover_pool_lock:
        if _discover_pool is None:
            _discover_pool = ThreadPoolExecutor(
                max_workers=4, thread_name_prefix="discover-load")
        return _discover_pool


def _get_enricher() -> Enricher:
    global _enricher
    with _enricher_lock:
        if _enricher is None:
            _enricher = Enricher(
                load_records=lambda storage: _cached_records(storage, False),
                load_tracks=lambda storage: _cached_tracks(storage, False),
                load_saved=_discover_saved,
                load_dismissed=_cached_dismissed)
        return _enricher


def _discover_payload(enricher=None) -> dict:
    """Generos y candidatos con lo que ya esta cacheado. Bloquea: va a un thread."""
    from .recommend import artist_weights, candidates, user_genres

    storage = get_storage()
    if enricher is None:
        enricher = _enricher
    # En frio cada entrada es una request a la nube: se piden a la vez, asi
    # se espera la mas lenta y no la suma. Con todo cacheado no cuesta nada.
    pool = _discover_loader_pool()
    entries = pool.submit(_cached, "scan", lambda: _discover_entries(storage),
                          storage=storage, ttl=DISCOVER_CACHE_SECONDS)
    records = pool.submit(_discover_records, storage, enricher)
    dismissed = pool.submit(_cached_dismissed, storage)
    summary = pool.submit(_cached_summary, storage)
    entries, records = entries.result(), records.result()
    dismissed, summary = dismissed.result(), summary.result()
    library = library_artists(entries)
    # Las guardadas van en `entries` con su artista: un id `yt:`/`ia:` del
    # historial se resuelve igual que la ruta de un archivo.
    weights = artist_weights(library, entries, summary.get("tracks", {}))
    return {"genres": user_genres(library, records, weights),
            "artists": candidates(library, records, weights, dismissed)}


async def discover(request: Request):
    """GET /api/discover: perfil de generos y artistas para descubrir.

    Responde con lo que hay cacheado (rapido) y arranca el enricher en segundo
    plano. Con la biblioteca vacia o sin red devuelve listas vacias y el
    `status` lo cuenta.
    """
    enricher = _get_enricher()
    data = await asyncio.to_thread(_discover_payload, enricher)
    try:
        enricher.ensure_started()
    except Exception as exc:
        # Sin enricher la vista sigue mostrando lo cacheado.
        log.warning("no se pudo arrancar el enricher: %s", exc)
    return JSONResponse({"status": enricher.status(), **data})


async def artist_genres_route(request: Request):
    """GET /api/artist/genres?name=: generos de UN artista, sin red.

    Lee las fichas que ya guardo el enricher (las mismas que usa Discover) y
    NUNCA lo arranca: eso lo hace `/api/discover`. Un artista que todavia no se
    perfilo devuelve `genres: []` y la UI esconde la tarjeta.
    """
    from .recommend import artist_genres

    name = _query_str(request, "name", required=True, min_length=1,
                      max_length=200)
    if not name.strip():
        raise _invalid(["query", "name"],
                       "String should have at least 1 characters")
    try:
        records = await asyncio.to_thread(
            _discover_records, get_storage(), _enricher)
    except Exception as exc:
        log.warning("no se pudieron leer las fichas de artista: %s", exc)
        records = {}
    genres = artist_genres(name, records)
    return JSONResponse({"name": name, "genres": [
        {"name": g["name"], "share": round(g["share"], 3)} for g in genres]})


def _dismiss_body(body: dict) -> tuple[str, bool]:
    """Valida `{name, undo}` del POST, con el mismo 422 que el resto de la API."""
    name = body.get("name")
    if not isinstance(name, str):
        raise _invalid(["body", "name"],
                       "Field required" if "name" not in body
                       else "Input should be a valid string")
    if len(name) < 1:
        raise _invalid(["body", "name"],
                       "String should have at least 1 characters")
    if len(name) > 200:
        raise _invalid(["body", "name"],
                       "String should have at most 200 characters")
    if not name.strip():
        raise _invalid(["body", "name"],
                       "String should have at least 1 characters")
    undo = body.get("undo", False)
    if not isinstance(undo, bool):
        raise _invalid(["body", "undo"], "Input should be a valid boolean")
    return name, undo


async def discover_dismiss(request: Request):
    """POST /api/discover/dismiss: descarta (o deshace) un artista."""
    name, undo = _dismiss_body(await _json_body(request))
    storage = get_storage()
    await asyncio.to_thread(storage.dismiss_artist, name, undo)
    # El set de descartes cacheado se actualiza en el acto: el proximo GET ya
    # lo ve, sin esperar a la nube.
    _apply_dismissal(storage, name, undo)
    return JSONResponse({"ok": True})


# ----------------------------------------------------------------- cookies YT
# Ultimo recurso para el muro de verificacion de YouTube. El archivo NUNCA se
# devuelve: la API solo informa estado (configurado, cuando se importo y
# cuantas cookies). El contenido se guarda cifrado (DPAPI) o con 0600.
async def _cookies_upload(request: Request) -> bytes:
    """Bytes del archivo subido: multipart (`file`) o cuerpo de texto crudo."""
    ctype = request.headers.get("content-type", "")
    if ctype.startswith("multipart/form-data"):
        form = await request.form()
        subido = form.get("file")
        if subido is None or isinstance(subido, str):
            return b""
        data = await subido.read()
        return data if isinstance(data, bytes) else str(data).encode("utf-8")
    return await request.body()


async def youtube_cookies_info(request: Request):
    """GET /api/youtube/cookies: estado sin exponer el contenido."""
    from . import youtube_cookies
    return JSONResponse(await asyncio.to_thread(youtube_cookies.status))


async def youtube_cookies_import(request: Request):
    """POST /api/youtube/cookies: importa un cookies.txt (200 o 422)."""
    from . import youtube_cookies
    raw = await _cookies_upload(request)
    try:
        info = await asyncio.to_thread(youtube_cookies.import_bytes, raw)
    except youtube_cookies.CookieImportError as e:
        raise _invalid(["body", "file"], str(e))
    return JSONResponse(info)


async def youtube_cookies_delete(request: Request):
    """DELETE /api/youtube/cookies: olvida las cookies importadas."""
    from . import youtube_cookies
    await asyncio.to_thread(youtube_cookies.remove)
    return Response(status_code=204)


# --------------------------------------------------------- almacenamiento activo
# La pantalla de conexion elige donde vive la biblioteca (este dispositivo o una
# nube) sin tocar variables de entorno. Hoy el unico proveedor es Google Drive.
_CONNECT_PROVIDERS = ("google",)
_STORAGE_CHOICES = ("local", "google")

_connect_flow = None


def _new_connect_flow():
    """Arma el flujo del proceso: al conectar, deja ese proveedor como activo.

    En Android no hay navegador: el flujo espera a que Kotlin empuje el token
    (`cloud/android.py`). En la PC es el loopback de siempre.
    """
    from .cloud.android import AndroidConnectFlow, is_android
    from .cloud.settings import set_active_storage

    def _on_connected(provider: str) -> None:
        set_active_storage(provider)
        reset_storage()

    if is_android():
        return AndroidConnectFlow(on_connected=_on_connected)

    from .cloud.connect import ConnectFlow
    from .cloud.tokens import TokenStore, default_protector, default_token_dir

    store = TokenStore(default_token_dir(), default_protector())
    return ConnectFlow(store, on_connected=_on_connected)


def _get_connect_flow():
    """Flujo unico del proceso, creado la primera vez que hace falta."""
    global _connect_flow
    if _connect_flow is None:
        _connect_flow = _new_connect_flow()
    return _connect_flow


def _provider_from_body(body: dict, choices: tuple[str, ...]) -> str:
    """Valida `provider` del cuerpo, con el mismo 422 que el resto de la API."""
    provider = body.get("provider")
    if provider not in choices:
        esperado = " or ".join(repr(c) for c in choices)
        raise _invalid(["body", "provider"], f"Input should be {esperado}")
    return provider


def _storage_payload(flow) -> dict:
    """Cuerpo de `GET /api/storage`. Bloquea: `describe` y tokens son I/O."""
    from .cloud.android import is_android
    from .cloud.connect import provider_for
    from .cloud.oauth import OAuthNotConfigured
    from .cloud.settings import active_storage

    android = is_android()
    if android:
        # Sin client id de escritorio y sin que falte: el token lo trae el host.
        configured = True
    else:
        try:
            provider_for("google")
            configured = True
        except (OAuthNotConfigured, ValueError):
            configured = False
    # `SPITIFO_STORAGE` pisa el ajuste en get_storage: la UI tiene que mostrar
    # lo que de verdad se esta usando, no lo que dice storage.json.
    override = os.getenv("SPITIFO_STORAGE", "").strip()
    storage = get_storage()
    quota = None
    if hasattr(storage, "quota"):
        try:
            quota = storage.quota()
        except Exception as exc:
            # Sin cuota la pantalla sigue sirviendo: solo no dibuja la barra.
            log.warning("no se pudo leer la cuota: %s: %s", type(exc).__name__, exc)
    return {
        "active": override or active_storage(),
        "override": bool(override),
        "library": storage.describe(),
        "quota": quota,
        # Como se firma el sign-in en este dispositivo: la UI decide con esto si
        # abre un link o si le pide el token al shell nativo.
        # Cuanto pode estar atrasada una version antigua que solo lee el
        # indice: los cambios del journal se funden en el al cerrar un grupo,
        # al quedar idle o al apagar. Se muestra en Ajustes.
        "index_journal": (storage.journal_stats()
                          if hasattr(storage, "journal_stats") else None),
        "connect_via": "android" if android else "browser",
        "providers": [{
            "id": "google",
            "name": "Google Drive",
            "configured": configured,
            "connected": flow.is_connected("google"),
        }],
        "connect": flow.status(),
    }


async def storage_info(request: Request):
    """Estado del almacenamiento: activo, biblioteca, proveedores y flujo."""
    flow = _get_connect_flow()
    return JSONResponse(await asyncio.to_thread(_storage_payload, flow))


async def storage_connect(request: Request):
    """Arranca el sign-in. Devuelve la URL para que la UI abra el navegador."""
    from .cloud.oauth import OAuthNotConfigured
    body = await _json_body(request)
    provider = _provider_from_body(body, _CONNECT_PROVIDERS)
    flow = _get_connect_flow()
    try:
        url = await asyncio.to_thread(flow.start, provider)
    except OAuthNotConfigured as exc:
        return JSONResponse({"detail": str(exc), "code": "not_configured"},
                            status_code=409)
    return JSONResponse({"auth_url": url, "connect": flow.status()},
                        status_code=202)


async def storage_connect_cancel(request: Request):
    """Cancela el sign-in en curso y devuelve el estado nuevo."""
    flow = _get_connect_flow()
    await asyncio.to_thread(flow.cancel)
    return JSONResponse(flow.status())


async def storage_use(request: Request):
    """Cambia el almacenamiento activo SIN volver a firmar el sign-in.

    `google` exige tokens guardados: cambiar el ajuste no conecta la cuenta.
    """
    from .cloud.settings import set_active_storage
    body = await _json_body(request)
    provider = _provider_from_body(body, _STORAGE_CHOICES)
    flow = _get_connect_flow()
    if provider == "google" and not await asyncio.to_thread(
            flow.is_connected, "google"):
        return JSONResponse({"detail": "Google Drive is not connected",
                             "code": "not_connected"}, status_code=409)
    await asyncio.to_thread(set_active_storage, provider)
    reset_storage()
    return JSONResponse(await asyncio.to_thread(_storage_payload, flow))


async def storage_disconnect(request: Request):
    """Borra los tokens; si ese proveedor estaba activo, vuelve a local."""
    from .cloud.settings import active_storage, set_active_storage
    body = await _json_body(request)
    provider = _provider_from_body(body, _CONNECT_PROVIDERS)
    flow = _get_connect_flow()

    def _do() -> None:
        flow.disconnect(provider)
        if active_storage() == provider:
            # Sin tokens, dejar `google` activo solo daria errores al leer.
            set_active_storage("local")
            reset_storage()

    await asyncio.to_thread(_do)
    return JSONResponse(await asyncio.to_thread(_storage_payload, flow))


# Un solo rango, en la forma `bytes=a-b`, `bytes=a-` o `bytes=-n`. Los demas
# casos (varios rangos, sintaxis rota) se IGNORAN y se manda el archivo entero,
# como recomienda la RFC 7233 para un header que no se puede satisfacer.
_RANGO = re.compile(r"^bytes=(\d*)-(\d*)$")
_UNIT = "bytes"

#: Extensiones que sirve `/api/audio`: audio, video y la miniatura `.jpg`.
_SERVE_EXTS = AUDIO_EXTS + VIDEO_EXTS + IMAGE_EXTS
# Una semana: la miniatura `.jpg` de un tema (privada: la API es del usuario).
_THUMB_CACHE = {"Cache-Control": "private, max-age=604800"}
# Un ano: los JPG de `.art/` son content-addressed, el nombre CAMBIA si cambian
# los bytes. Se pueden cachear sin miedo a servir una imagen vieja.
_ART_CACHE = {"Cache-Control": "private, max-age=31536000, immutable"}
#: Extensiones que tiene sentido adelantar con `/api/prefetch` (el video tambien
#: se reproduce: la UI precarga el proximo tema). Una miniatura no se precarga.
_PREFETCH_EXTS = AUDIO_EXTS + VIDEO_EXTS


def _parse_range(valor: str | None, size: int) -> tuple[int, int] | None | str:
    """Devuelve `(start, end)` inclusivo, None (ignorar) o "insatisfacible".

    Los limites se recortan al archivo: `end` mas alla del final se limita al
    ultimo byte y un sufijo mas grande que el archivo empieza en 0.
    """
    if not valor:
        return None
    m = _RANGO.match(valor.strip().lower())
    if not m:
        return None
    ini, fin = m.group(1), m.group(2)
    if not ini and not fin:
        return None
    if size == 0:
        return "insatisfacible"
    if not ini:  # sufijo: los ultimos `fin` bytes
        n = int(fin)
        if n == 0:
            return "insatisfacible"
        return (max(0, size - n), size - 1)
    start = int(ini)
    if start >= size:
        return "insatisfacible"
    if not fin:
        return (start, size - 1)
    end = int(fin)
    if end < start:
        return None
    return (start, min(end, size - 1))


async def audio(request: Request):
    """Sirve un archivo de la biblioteca, con soporte de `Range` (206).

    La clave es relativa a la raiz de la biblioteca: el puerto `Storage` dice si
    existe y de donde salen los bytes, asi que la API no maneja rutas del host.

    Aunque la ruta se llame `/api/audio` sirve TAMBIEN video (.mp4/.webm/.mkv) y
    la miniatura `.jpg`: la UI reproduce el video y dibuja el poster desde aca,
    con los mismos chequeos de clave y el mismo manejo de `Range`.
    """
    key = _query_str(request, "key", required=True)
    if Path(key).suffix.lower() not in _SERVE_EXTS:
        raise HTTPException(404, "no encontrado")
    storage = get_storage()
    try:
        # Al pool de storage (no al default): en un adapter remoto stat es una
        # llamada de red, y en el local un acceso a disco; ninguno debe frenar
        # el event loop NI esperar detras de una extraccion de yt-dlp (pool
        # separado, ver executors.py).
        size = (await run_storage(storage.stat, key)).size
    except (InvalidKey, FileNotFoundError, OSError):
        raise HTTPException(404, "no encontrado")

    # El MIME sale de la extension; configure_runtime ya registro los tipos de
    # audio, video y `.jpg` que Android no trae.
    ctype = mimetypes.guess_type(key)[0] or "application/octet-stream"
    # La miniatura no cambia mientras el archivo exista: sin esto cada fila que
    # se monta de nuevo en la lista virtual la vuelve a pedir (con Drive, un
    # viaje a la red). El audio y el video ya viajan con `Range` y no se cachean.
    cache = _ART_CACHE if key.startswith(f"{ART_DIR}/") else (
        _THUMB_CACHE if Path(key).suffix.lower() in IMAGE_EXTS else {})
    rango = _parse_range(request.headers.get("range"), size)
    if rango == "insatisfacible":
        return Response(status_code=416, headers={
            "Content-Range": f"bytes */{size}", "Accept-Ranges": _UNIT})

    if isinstance(rango, tuple):
        start, end = rango
        headers = {
            "Accept-Ranges": _UNIT,
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(end - start + 1),
            **cache,
        }
        # open_range a un thread: en un adapter remoto abre la descarga (y
        # falla con 503/502 si hace falta) antes de mandar los headers.
        body = await run_storage(storage.open_range, key, start, end)
        return StreamingResponse(body, status_code=206, media_type=ctype,
                                 headers=headers)

    body = await run_storage(storage.open_range, key)
    return StreamingResponse(
        body, media_type=ctype,
        headers={"Accept-Ranges": _UNIT, "Content-Length": str(size), **cache})


def _prefetch_bg(fn, key: str) -> None:
    """Corre `prefetch` fuera del request: los fallos se loguean, no se tiran."""
    try:
        fn(key)
    except Exception as exc:
        log.warning("prefetch de %s fallo: %s: %s", key, type(exc).__name__, exc)


#: Referencia al ultimo prefetch encolado (solo para diagnostico/tests): lo
#: que REEMPLAZA no es el trabajo en curso (`Storage.prefetch` no tiene
#: cancelacion: la descarga que ya arranco en Drive sigue aunque el usuario
#: saltee de nuevo, igual que antes), sino la garantia de que un tap repetido
#: de "siguiente" (saltar varias veces rapido) ya NO abre un hilo de SO por
#: tap: se encola en `PREFETCH_EXECUTOR`, un pool chico y PROPIO (ver
#: executors.py) que nunca compite por hilos con `/api/audio`, la biblioteca
#: o el guardado de la cola (eso sí pasaria si compartiera `STORAGE_EXECUTOR`:
#: una racha de saltos llenaria ese pool de descargas de Drive y haria
#: esperar a una lectura de audio real).
_prefetch_future: "asyncio.Future | None" = None


def _prefetch_submit(fn, key: str) -> None:
    global _prefetch_future
    _prefetch_future = run_prefetch(_prefetch_bg, fn, key)


async def prefetch(request: Request):
    """Adelanta la descarga del proximo tema (auto-advance de la biblioteca).

    La UI lo dispara al empezar un tema, con la clave del SIGUIENTE. La respuesta
    no espera la descarga: se encola y vuelve ya. Un almacenamiento sin cache
    (disco local) contesta 204: no hay nada que adelantar.
    """
    body = await _json_body(request)
    key = body.get("key")
    if not isinstance(key, str) or Path(key).suffix.lower() not in _PREFETCH_EXTS:
        raise HTTPException(400, "clave invalida")
    storage = get_storage()
    try:
        # Igual que /api/audio: `stat` confirma que existe antes de encolar nada.
        await run_storage(storage.stat, key)
    except (InvalidKey, FileNotFoundError, OSError):
        raise HTTPException(404, "no encontrado")
    fn = getattr(storage, "prefetch", None)
    if fn is None:
        return Response(status_code=204)
    _prefetch_submit(fn, key)
    return JSONResponse({"key": key}, status_code=202)


# ------------------------------------------------------------ buscar portadas
async def covers_missing(request: Request):
    """GET /api/covers/missing: temas de audio sin portada."""
    from .cover_finder import missing
    items = await asyncio.to_thread(missing)
    return JSONResponse({"count": len(items), "items": items})


async def covers_candidates(request: Request):
    """GET /api/covers/candidates?key&q: canciones de iTunes con portada."""
    from .cover_finder import CoverError, candidates
    key = _query_str(request, "key", required=True)
    q = _query_str(request, "q", required=True)
    try:
        found = await candidates(key, q)
    except CoverError as e:
        raise HTTPException(e.status, e.detail)
    return JSONResponse({"key": key, "query": q, "candidates": found})


async def covers_apply(request: Request):
    """POST /api/covers/apply {key, artwork_url}: guarda la portada confirmada."""
    from .cover_finder import CoverError, apply
    body = await _json_body(request)
    key = body.get("key")
    url = body.get("artwork_url")
    if not isinstance(key, str) or not key:
        raise _invalid(["body", "key"], "Field required")
    if not isinstance(url, str) or not url:
        raise _invalid(["body", "artwork_url"], "Field required")
    try:
        saved = await apply(key, url)
    except CoverError as e:
        raise HTTPException(e.status, e.detail)
    return JSONResponse(saved)


async def _http_exception(request: Request, exc: HTTPException) -> JSONResponse:
    """Mismo cuerpo de error que FastAPI: {"detail": ...} en todos los casos."""
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code,
                        headers=getattr(exc, "headers", None))


async def _reconnect_required(request: Request, exc: Exception) -> JSONResponse:
    """El token de la nube no sirve: la UI ofrece reconectar (ADR 0002, sec. 8).

    503 y no 401: un 401 en esta API significa "falta el secreto de lanzamiento"
    y la UI lo trata como sesion perdida.
    """
    return JSONResponse({"detail": str(exc), "code": "reconnect_required"},
                        status_code=503)


async def _quota_exceeded(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse({"detail": str(exc), "code": "quota_exceeded"},
                        status_code=507)


async def _storage_unreachable(request: Request, exc: Exception) -> JSONResponse:
    """La nube no contesto o contesto mal: no es un bug del backend."""
    log.warning("storage remoto: %s: %s", type(exc).__name__, exc)
    return JSONResponse({"detail": "cloud storage unreachable",
                         "code": "storage_unreachable"}, status_code=502)


def _exception_handlers() -> dict:
    """Errores del conector de nube, traducidos a respuestas que la UI entiende.

    Importa las clases recien aca: el conector solo existe si se usa.
    """
    import httpx

    from .cloud.drive import QuotaExceeded
    from .cloud.tokens import ReconnectRequired
    return {
        HTTPException: _http_exception,
        ReconnectRequired: _reconnect_required,
        QuotaExceeded: _quota_exceeded,
        httpx.HTTPError: _storage_unreachable,
    }


# ---------------------------------------------------------------- aplicacion
routes = [
    Route("/api/health", health),
    Route("/api/search", search),
    Route("/api/search/suggest", search_suggest),
    Route("/api/search/match/{track_id}", search_match),
    Route("/api/lyrics", lyrics_route),
    Route("/api/albums/search", albums_search),
    Route("/api/artists/search", artists_search),
    Route("/api/album/{id}/match", album_match),
    Route("/api/album/{id}", album_detail),
    Route("/api/resolve", resolve, methods=["POST"]),
    Route("/api/verify", verify),
    Route("/api/download/progress/{job_id}", progress),
    Route("/api/formats", formats),
    Route("/api/download", download, methods=["POST"]),
    Route("/api/download/warm", download_warm, methods=["POST"]),
    Route("/api/downloads", downloads_list, methods=["GET"]),
    Route("/api/downloads", downloads_enqueue, methods=["POST"]),
    Route("/api/downloads/cancel", downloads_cancel_group, methods=["POST"]),
    Route("/api/downloads/network", downloads_network, methods=["POST"]),
    Route("/api/downloads/{id}/cancel", downloads_cancel, methods=["POST"]),
    Route("/api/downloads/{id}/retry", downloads_retry, methods=["POST"]),
    Route("/api/setlist", setlist),
    Route("/api/library", library),
    Route("/api/library/delete", library_delete, methods=["POST"]),
    Route("/api/playlists", playlists),
    Route("/api/playlists/{id}", playlist_save, methods=["PUT"]),
    Route("/api/playlists/{id}", playlist_delete, methods=["DELETE"]),
    Route("/api/saved", saved_list),
    Route("/api/saved", saved_save, methods=["PUT"]),
    Route("/api/saved/remove", saved_remove, methods=["POST"]),
    Route("/api/art", art_list),
    Route("/api/art/upload", art_upload, methods=["POST"]),
    Route("/api/art/from-url", art_from_url, methods=["POST"]),
    Route("/api/art/reset", art_reset, methods=["POST"]),
    Route("/api/listens", listens_append, methods=["POST"]),
    Route("/api/listens/summary", listens_summary),
    Route("/api/discover", discover),
    Route("/api/discover/dismiss", discover_dismiss, methods=["POST"]),
    Route("/api/artist/genres", artist_genres_route),
    # /top va antes que la dinamica: asi "777/top" no se toma como id.
    Route("/api/artist/{id}/top", artist_top_songs),
    # La ruta dinamica va DESPUES de /api/artist/genres: si no, "genres" se
    # toma como id y la busqueda de generos da 422.
    Route("/api/artist/{id}", artist_detail),
    Route("/api/youtube/cookies", youtube_cookies_info),
    Route("/api/youtube/cookies", youtube_cookies_import, methods=["POST"]),
    Route("/api/youtube/cookies", youtube_cookies_delete, methods=["DELETE"]),
    Route("/api/storage", storage_info),
    Route("/api/storage/connect", storage_connect, methods=["POST"]),
    Route("/api/storage/connect/cancel", storage_connect_cancel,
          methods=["POST"]),
    Route("/api/storage/use", storage_use, methods=["POST"]),
    Route("/api/storage/disconnect", storage_disconnect, methods=["POST"]),
    Route("/api/audio", audio),
    Route("/api/stream", stream_audio),
    Route("/api/stream/prepare", stream_prepare, methods=["POST"]),
    Route("/api/prefetch", prefetch, methods=["POST"]),
    Route("/api/covers/missing", covers_missing),
    Route("/api/covers/candidates", covers_candidates),
    Route("/api/covers/apply", covers_apply, methods=["POST"]),
]
# Cache-Control del frontend compilado: los chunks de Vite bajo assets/ llevan
# el hash en el nombre (un ano es seguro, el nombre cambia si cambian los
# bytes); index.html apunta a esos chunks y no se cachea; el resto
# (genre-map.json, el favicon) usa un max-age corto. Sin esto StaticFiles solo
# manda ETag/Last-Modified: cada recarga revalida (304) hasta el ultimo chunk.
_STATIC_HASHED_CACHE = {"Cache-Control": "public, max-age=31536000, immutable"}
_STATIC_HTML_CACHE = {"Cache-Control": "no-cache"}
_STATIC_DEFAULT_CACHE = {"Cache-Control": "public, max-age=3600"}


class _FrontendStaticFiles(StaticFiles):
    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        path = Path(full_path)
        if path.name == "index.html":
            cache = _STATIC_HTML_CACHE
        elif path.parent.name == "assets":
            cache = _STATIC_HASHED_CACHE
        else:
            cache = _STATIC_DEFAULT_CACHE
        for k, v in cache.items():
            response.headers[k] = v
        return response


# Sirve el frontend compilado si existe (produccion single-port)
if FRONTEND_DIST.is_dir():
    routes.append(Mount("/", _FrontendStaticFiles(directory=FRONTEND_DIST, html=True),
                        name="frontend"))


def create_app(token: str | None = None) -> Starlette:
    """Arma la app. `token` es el secreto por lanzamiento (SPITIFO_TOKEN).

    Con `token=None` no hay middleware de auth: es exactamente el
    comportamiento de siempre (`uvicorn backend.app.main:app`, Vite dev con
    proxy, `run.bat`). Con token, toda request tiene que traerlo.
    """
    middleware = [Middleware(CORSMiddleware, allow_origins=["*"],
                             allow_methods=["*"], allow_headers=["*"])]
    if token:
        middleware.append(Middleware(TokenAuthMiddleware, token=token))
    return Starlette(
        routes=routes, lifespan=lifespan, middleware=middleware,
        exception_handlers=_exception_handlers(),
    )


app = create_app(os.getenv("SPITIFO_TOKEN"))
