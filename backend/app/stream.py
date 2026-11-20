"""Reproduccion en streaming: resolver la URL del formato y hacer de proxy.

El navegador (o el WebView de Android) pide `/api/stream?url=...` con un elemento
<audio>. Aca no se baja el tema: se resuelve la URL de formato que publica
YouTube y se sirven los bytes a trozos de 1 MiB, que es el limite que googlevideo
acepta sin cortar ni devolver 403.

Dos caminos de extraccion:

- rapido (`visionos`, sin webpage ni configs, con visitor_data): ~0,2 s; es el
  que se usa siempre que funciona.
- completo: el `probe_info` de ytdlp_source, con JS runtime, clientes de respaldo
  y reintento con cookies. Tarda ~2-3 s pero es el resiliente.

Cualquier fallo del camino rapido invalida el visitor_data (puede estar viejo) y
cae al completo. `YoutubeDL` NO es thread-safe: se usa un pool pequeno que se
descarta cuando cambia el visitor_data.
"""
from __future__ import annotations

import asyncio
import logging
import queue
import re
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator
from urllib.parse import parse_qs, urlparse

import httpx

from .config import USER_AGENT

log = logging.getLogger("spitifo.stream")

#: El visitor_data se saca de la home de YouTube; dura ~6 h.
VISITOR_TTL_S = 6 * 60 * 60
VISITOR_URL = "https://www.youtube.com/"
VISITOR_RE = re.compile(r'"VISITOR_DATA":"([^"]+)"')

#: Si la home de YouTube no contesta, no se reintenta en cada play: durante este
#: rato se va directo al camino completo en vez de esperar otro timeout.
VISITOR_BACKOFF_S = 5 * 60

#: Topes de cada camino. Ninguna resolucion puede dejar el boton girando para
#: siempre: el rapido cede al completo y el completo termina en un error que la
#: UI convierte en aviso. Un hilo vencido sigue hasta que yt-dlp corte (el
#: socket_timeout del rapido es de 10 s), pero ya nadie lo espera.
FAST_TIMEOUT_S = 8.0
FULL_TIMEOUT_S = 45.0
#: Una resolucion mas lenta que esto se registra como aviso para diagnosticar.
SLOW_LOG_S = 5.0

#: googlevideo corta o niega rangos abiertos: siempre pedimos trozos acotados.
MAX_CHUNK = 1024 * 1024

#: Los resultados se guardan hasta 60 s antes de que venza la URL de formato.
CACHE_MARGIN_S = 60.0
CACHE_MAX = 64

_VIDEO_RE = re.compile(r"(?:v=|/)([A-Za-z0-9_-]{11})(?:[?&#/]|$)")
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


@dataclass(frozen=True)
class StreamInfo:
    """Lo que necesita el proxy para servir una pista, sin el resto del info."""

    url: str
    headers: dict[str, str]
    ext: str
    mime: str
    filesize: int | None
    duration: float | None
    expires_at: float
    path: str


# ---------------------------------------------------------------- visitor data
_visitor: str | None = None
_visitor_at = 0.0
_visitor_failed_at = 0.0
_visitor_lock = threading.Lock()

_pool: queue.Queue = queue.Queue(maxsize=3)
_pool_visitor: str | None = None
_pool_lock = threading.Lock()


def _fetch_visitor_sync() -> str | None:
    """GET a la home una vez; solo se loguea si falla (nunca va al critical path)."""
    try:
        with httpx.Client(timeout=httpx.Timeout(8.0), follow_redirects=True) as c:
            r = c.get(VISITOR_URL, headers={"User-Agent": "Mozilla/5.0"})
            r.raise_for_status()
        m = VISITOR_RE.search(r.text)
        return m.group(1) if m else None
    except Exception as e:
        log.info("stream: no se pudo leer visitor_data: %s", e)
        return None


#: Espera antes de preparar yt-dlp: importarlo es CPU pura (~1 s en el PC,
#: varias veces mas en un telefono) y no debe competir con la primera pantalla.
PREWARM_DELAY_S = 4.0


def _prewarm_sync(visitor: str | None) -> None:
    """Deja un YoutubeDL listo en el pool con la conexion TLS ya abierta.

    El primer play pagaba importar yt-dlp, construir la instancia, cargar los
    certificados y abrir la conexion con youtube.com (~1,7 s en el PC). Con
    esto el primer play cuesta lo mismo que el segundo.
    """
    global _pool_visitor
    from yt_dlp.networking import Request

    ydl = _new_youtube(visitor)
    try:
        ydl.urlopen(Request("https://www.youtube.com/generate_204")).read()
    except Exception as e:
        log.info("stream: no se pudo abrir la conexion de antemano: %s", e)
    with _pool_lock:
        if _pool_visitor not in (None, visitor):
            return
        try:
            _pool.put_nowait(ydl)
        except queue.Full:
            return
        _pool_visitor = visitor


async def warm_visitor() -> None:
    """Arranca en background al levantar la app; un fallo solo se registra."""
    try:
        visitor = await ensure_visitor()
        if visitor:
            await asyncio.sleep(PREWARM_DELAY_S)
            await asyncio.to_thread(_prewarm_sync, visitor)
        # El cliente del proxy carga sus certificados al crearse: mejor ahora
        # que en el primer play.
        await asyncio.to_thread(client)
    except Exception as e:
        log.info("stream: preparacion en background fallo: %s", e)


async def ensure_visitor() -> str | None:
    """Devuelve el visitor_data en cache o lo busca; TTL de 6 h."""
    global _visitor, _visitor_at, _visitor_failed_at
    now = time.time()
    with _visitor_lock:
        if _visitor and now - _visitor_at < VISITOR_TTL_S:
            return _visitor
        if now - _visitor_failed_at < VISITOR_BACKOFF_S:
            return None
    data = await asyncio.to_thread(_fetch_visitor_sync)
    with _visitor_lock:
        if data:
            _visitor = data
            _visitor_at = time.time()
        else:
            _visitor_failed_at = time.time()
    if data:
        _reset_pool()
    return data


def invalidate() -> None:
    """Descarta el visitor_data y los YoutubeDL construidos con el."""
    global _visitor, _visitor_at, _visitor_failed_at
    with _visitor_lock:
        _visitor = None
        _visitor_at = 0.0
        _visitor_failed_at = 0.0
    _reset_pool()


def _reset_pool() -> None:
    global _pool_visitor
    with _pool_lock:
        _pool_visitor = None
        while True:
            try:
                ydl = _pool.get_nowait()
            except queue.Empty:
                break
            close = getattr(ydl, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass


def _new_youtube(visitor: str | None):
    import yt_dlp

    args: dict[str, Any] = {
        "youtube": {
            "player_client": ["visionos"],
            "player_skip": ["webpage", "configs", "initial_data"],
            "skip": ["hls"],
        }
    }
    if visitor:
        args["youtube"]["visitor_data"] = [visitor]
    return yt_dlp.YoutubeDL({
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "socket_timeout": 10,
        "extractor_args": args,
    })


@contextmanager
def _pooled(visitor: str | None):
    """Presta un YoutubeDL del pool; se descarta si falla o cambia el visitor."""
    global _pool_visitor
    with _pool_lock:
        if _pool_visitor != visitor:
            while True:
                try:
                    viejo = _pool.get_nowait()
                except queue.Empty:
                    break
                close = getattr(viejo, "close", None)
                if callable(close):
                    try:
                        close()
                    except Exception:
                        pass
            _pool_visitor = visitor
        try:
            ydl = _pool.get_nowait()
        except queue.Empty:
            ydl = None
    if ydl is None:
        ydl = _new_youtube(visitor)
    try:
        yield ydl
    except Exception:
        close = getattr(ydl, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass
        raise
    else:
        try:
            _pool.put_nowait(ydl)
        except queue.Full:
            close = getattr(ydl, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass


# ------------------------------------------------------------------- resolucion
def video_id(url: str) -> str | None:
    m = _VIDEO_RE.search(url or "")
    return m.group(1) if m else None


def mime_of(ext: str) -> str:
    e = (ext or "").lower()
    if e in ("webm", "opus"):
        return "audio/webm"
    if e in ("m4a", "mp4", "aac"):
        return "audio/mp4"
    if e in ("mp3", "mpeg"):
        return "audio/mpeg"
    if e in ("ogg", "oga"):
        return "audio/ogg"
    return f"audio/{e}" if e else "application/octet-stream"


def expires_of(url: str) -> float:
    """`expire` del URL de formato (epoch); si no viene, una hora."""
    raw = parse_qs(urlparse(url or "").query).get("expire", [None])[0]
    if raw:
        try:
            return float(raw)
        except (TypeError, ValueError):
            pass
    return time.time() + 3600.0


def pick_audio(info: dict) -> dict:
    """El mejor formato de solo audio de un info SIN procesar (`process=False`).

    Procesar con yt-dlp es lo que mas CPU gasta: reconstruye la URL de los ~30
    formatos del video para elegir uno. En el telefono eso pesa mas que la red,
    asi que la eleccion es esta: solo audio, con URL, la pista original antes
    que un doblaje y despues la de mas bitrate (251 opus o 140 m4a). Un info ya
    procesado (camino completo) trae la URL arriba y se devuelve tal cual.
    """
    if info.get("url") or not info.get("formats"):
        return info
    audios = [f for f in info["formats"]
              if f.get("url") and f.get("vcodec") == "none"
              and f.get("acodec") not in (None, "none")]
    if not audios:
        raise RuntimeError("el video no tiene formato de solo audio")
    def orden(f):
        lp = f.get("language_preference")
        return (-1 if lp is None else lp, f.get("quality") or 0, f.get("tbr") or 0)

    best = max(audios, key=orden)
    return {**best, "duration": info.get("duration"),
            "http_headers": best.get("http_headers") or info.get("http_headers")}


def _from_info(info: dict, path: str) -> StreamInfo:
    url = info.get("url") or ""
    if not url:
        raise RuntimeError("yt-dlp no devolvio URL de formato")
    ext = str(info.get("ext") or "webm")
    size = info.get("filesize")
    if not isinstance(size, (int, float)) or isinstance(size, bool):
        size = info.get("filesize_approx")
    filesize = int(size) if isinstance(size, (int, float)) and size > 0 else None
    dur = info.get("duration")
    duration = float(dur) if isinstance(dur, (int, float)) and not isinstance(dur, bool) else None
    return StreamInfo(
        url=url,
        headers={str(k): str(v) for k, v in (info.get("http_headers") or {}).items()},
        ext=ext,
        mime=mime_of(ext),
        filesize=filesize,
        duration=duration,
        expires_at=expires_of(url),
        path=path,
    )


_cache: dict[str, StreamInfo] = {}
_pending: dict[str, asyncio.Task] = {}
_lock = threading.Lock()


def drop(video_key: str) -> None:
    """Saca una entrada vencida (o que el upstream ya no sirve)."""
    with _lock:
        _cache.pop(video_key, None)


def clear() -> None:
    """Solo para tests: limpia entradas y tareas en vuelo."""
    global _client
    with _lock:
        _cache.clear()
        _pending.clear()
    _client = None
    invalidate()


async def resolve(url: str, *, force: bool = False) -> StreamInfo:
    """Resuelve `url` con cache por id y una sola tarea por video concurrente."""
    vid = video_id(url) or url
    with _lock:
        hit = _cache.get(vid)
        if not force and hit and hit.expires_at - CACHE_MARGIN_S > time.time():
            return hit
        task = _pending.get(vid) if not force else None
        if task is None:
            task = asyncio.create_task(_resolve_uncached(url, vid))
            _pending[vid] = task
            task.add_done_callback(lambda _t, v=vid: _pending.pop(v, None))
    return await asyncio.shield(task)


async def _resolve_uncached(url: str, vid: str) -> StreamInfo:
    from . import ytdlp_source
    from .ytdlp_source import BotCheckError

    t0 = time.monotonic()
    try:
        visitor = await ensure_visitor()
        if not visitor:
            # Sin visitor_data el camino rapido choca con el muro: ni se intenta.
            raise RuntimeError("sin visitor_data")
        with _pooled(visitor) as ydl:
            info = await asyncio.wait_for(
                asyncio.to_thread(ydl.extract_info, url, download=False, process=False),
                FAST_TIMEOUT_S)
        salida = _from_info(pick_audio(info), "fast")
    except Exception as e:
        # Un visitor_data viejo es la causa mas comun: se descarta y se reintenta
        # con el camino completo, que es mas lento pero aguanta el muro.
        log.info("stream: camino rapido fallo (%s), probando el completo", type(e).__name__)
        invalidate()
        try:
            info = await asyncio.wait_for(
                ytdlp_source.probe_info(url, format="bestaudio"), FULL_TIMEOUT_S)
            salida = _from_info(info, "full")
        except BotCheckError:
            raise
        except Exception as e2:
            log.info("stream: resolve %s fallo: %s", vid, e2)
            raise
    with _lock:
        _cache[vid] = salida
        if len(_cache) > CACHE_MAX:
            for clave in sorted(_cache, key=lambda k: _cache[k].expires_at)[:len(_cache) - CACHE_MAX]:
                del _cache[clave]
    pasado = time.monotonic() - t0
    log.log(logging.WARNING if pasado > SLOW_LOG_S else logging.INFO,
            "stream resolve %s: %s %d ms", vid, salida.path, int(pasado * 1000))
    return salida


# ---------------------------------------------------------------------- proxy
class UpstreamGone(RuntimeError):
    """El formato vencio (403/410) antes de mandar el primer byte al cliente."""


def parse_range(value: str | None, size: int | None = None):
    """Devuelve `(start, end, parcial)`, None (ignorar) o "insatisfacible".

    `size=None` mientras no se conocen los bytes totales: el proxy lo saca del
    Content-Range del primer trozo del upstream.
    """
    if not value:
        return (0, None, False)
    m = _RANGE_RE.match(value.strip().lower())
    if not m:
        return (0, None, False)
    ini, fin = m.group(1), m.group(2)
    if not ini and not fin:
        return (0, None, False)
    if not ini:
        n = int(fin)
        if n <= 0:
            return "insatisfacible"
        if size is None:
            return (0, None, True)
        return (max(0, size - n), size - 1, True)
    start = int(ini)
    if size is not None and start >= size:
        return "insatisfacible"
    end = int(fin) if fin else None
    if end is not None:
        if end < start:
            return (0, None, False)
        if size is not None:
            end = min(end, size - 1)
    return (start, end, True)


def make_client() -> httpx.AsyncClient:
    """Cliente async del proxy. Los tests lo cambian por httpx.MockTransport."""
    return httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=60.0),
                             follow_redirects=True, headers={"User-Agent": USER_AGENT})


_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    """Un cliente para todo el proceso: cada arranque y cada salto dentro de la
    cancion reusan la conexion abierta con googlevideo en vez de pagar otro
    handshake TLS (~0,1 s, mas en el telefono)."""
    global _client
    if _client is None or _client.is_closed:
        _client = make_client()
    return _client


async def aclose() -> None:
    """Cierra el cliente compartido al apagar la app."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


class Upstream:
    """Encadena rangos de 1 MiB hacia el cliente, cerrando al desconectarse."""

    def __init__(self, info: StreamInfo, client: httpx.AsyncClient,
                 start: int = 0, end: int | None = None) -> None:
        self.info = info
        self.client = client
        self.start = start
        self.end = end
        self.total = info.filesize
        self.pos = start
        self._cm = None
        self._resp = None

    def _open_chunk(self):
        last = self.pos + MAX_CHUNK - 1
        if self.end is not None:
            last = min(last, self.end)
        headers = dict(self.info.headers)
        headers["Range"] = f"bytes={self.pos}-{last}"
        cm = self.client.stream("GET", self.info.url, headers=headers)
        return cm

    async def _enter(self, cm):
        resp = await cm.__aenter__()
        if resp.status_code in (403, 410):
            await cm.__aexit__(None, None, None)
            raise UpstreamGone(f"upstream {resp.status_code}")
        if resp.status_code not in (200, 206):
            await cm.__aexit__(None, None, None)
            raise RuntimeError(f"upstream {resp.status_code}")
        if self.total is None:
            cr = resp.headers.get("content-range", "")
            if "/" in cr:
                try:
                    self.total = int(cr.rsplit("/", 1)[1])
                except (TypeError, ValueError):
                    pass
        self._cm, self._resp = cm, resp
        return resp

    async def open(self) -> int | None:
        """Abre el primer trozo para conocer el total antes de enviar headers."""
        await self._enter(self._open_chunk())
        return self.total

    async def body(self):
        try:
            while True:
                if self._resp is None:
                    if self.end is not None and self.pos > self.end:
                        break
                    await self._enter(self._open_chunk())
                got = 0
                async for piece in self._resp.aiter_bytes(65536):
                    got += len(piece)
                    yield piece
                await self._cm.__aexit__(None, None, None)
                self._cm, self._resp = None, None
                if got == 0:
                    break
                self.pos += got
                if self.total is not None and self.pos >= self.total:
                    break
                if self.end is not None and self.pos > self.end:
                    break
        finally:
            if self._resp is not None:
                await self._cm.__aexit__(None, None, None)
                self._cm, self._resp = None, None
