"""yt-dlp: buscar y descargar audio de YouTube.

Fuente EXTRA, apagada por defecto (YTDLP_ENABLED=1). Verificado en vivo: en esta
maquina (sep 2026) YouTube responde bien, da 5 formatos de solo-audio y el
progress hook anda.

Notas reales de la implementacion:
- la busqueda usa `extract_flat` (no baja metadata de cada video, es rapido)
- la descarga corre en un thread porque yt-dlp es sincrono y bloquearia FastAPI
- el progreso se reporta por una cola; la UI lo consume por polling
- el postprocessor de ffmpeg deja mp3/m4a con tags; con "original" extrae el
  audio sin recodificar (opus -> .opus, aac -> .m4a)
- los errores transitorios (HTTP 403/429/5xx, cortes de conexion) se reintentan
"""
from __future__ import annotations

import asyncio
import glob
import hashlib
import logging
import os
import queue
import re
import shutil
import threading
import time
import uuid
import weakref
from pathlib import Path
from typing import Any, Callable

from .config import AUDIO_EXTS, USER_AGENT, VIDEO_EXTS
from .executors import run_storage, run_ytdlp
from .models import Track, safe_name
from .sources import Source, looks_like_music, relevance

log = logging.getLogger("spitifo.ytdlp")

#: Tope de reloj para cada llamada de red de yt-dlp (busqueda/resolve/probe):
#: ninguna puede dejar un hilo del pool colgado para siempre. yt-dlp hace
#: varios pedidos HTTP por extraccion (player API, formatos); su propio
#: `socket_timeout` (30-60s, por llamada HTTP) no alcanza para acotar el
#: TOTAL. Mas holgado que `stream.FAST_TIMEOUT_S` (8 s, una sola extraccion
#: con visitor_data): un ytsearch40 o una extraccion completa en un telefono
#: de gama media con 4G flojo puede pasar de 8 s sin estar colgado, y cortarlo
#: ahi deja la busqueda sin versiones enteras.
YTDLP_CALL_TIMEOUT_S = 20.0

#: La extraccion COMPLETA (`probe_info`, el camino resiliente con reintento de
#: cookies) es mas lenta a proposito: mismo valor que `stream.FULL_TIMEOUT_S`.
PROBE_TIMEOUT_S = 45.0

# progreso de las descargas en curso: job_id -> dict
JOBS: dict[str, dict] = {}
_JOBS_LOCK = threading.Lock()


# ------------------------------------------------------- import en background
# `import yt_dlp` tarda ~1 s en el PC (mas en el telefono): si una ruta lo hace
# directo en el loop, esa busqueda o ese play se congelan ese tiempo entero. Una
# sola tarea de fondo lo importa en un hilo apenas arranca la app (no hay que
# esperar los 4 s del prewarm de red, que es aparte); cualquier ruta que lo
# necesite espera esta tarea en vez de importar ella misma.
_IMPORT_TASK: asyncio.Task | None = None


def _import_yt_dlp_sync() -> None:
    import yt_dlp  # noqa: F401


async def ensure_yt_dlp_imported() -> None:
    """Espera a que yt_dlp este importado, sin bloquear el loop si todavia no.

    El modulo se carga una sola vez (Python lo cachea en sys.modules): despues
    de la primera vez, `import yt_dlp` es practicamente gratis, asi que no hace
    falta memoizar nada mas que la tarea en si. Una tarea que fallo o se
    cancelo se vuelve a intentar (un zip de yt-dlp roto no deja la busqueda
    muerta hasta reiniciar), y `shield` evita que un pedido cancelado (el
    cliente se fue) cancele el import que esperan todos los demas."""
    global _IMPORT_TASK
    task = _IMPORT_TASK
    if task is not None and task.done() and not task.cancelled() \
            and task.exception() is None:
        return
    if task is None or task.done():
        task = _IMPORT_TASK = asyncio.ensure_future(
            asyncio.to_thread(_import_yt_dlp_sync))
    await asyncio.shield(task)

# Estados finales: un job en cualquiera de estos ya no se va a tocar mas.
_DONE_STATES = ("done", "error")

# Cuanto tiempo se quedan los jobs terminados antes de purgarse. 1 hora es
# mucho mas que lo que tarda la UI en terminar de hacer polling (la descarga
# dura minutos) y deja margen para recargar la pagina y ver el resultado, pero
# acota el crecimiento del dict en sesiones largas.
JOBS_TTL_S = 3600.0

# Una descarga por ruta de salida a la vez.
#
# DOS resultados que resuelven al MISMO video (iTunes devuelve "Yesterday" tres
# veces) comparten `folder/<artista> - <titulo>` como nombre de salida. Windows no
# deja abrir dos veces el mismo archivo: la segunda muere con
# `[WinError 32] El proceso no tiene acceso al archivo porque esta siendo
# utilizado por otro proceso` y el toast dice "Falló la descarga" sin motivo
# visible. Los archivos .webm/.mp3 nunca quedan a medias.
#
# Con un lock por ruta, la segunda espera a que la primera termine de bajar Y de
# escribir los tags, y recien despues usa el archivo. No se renombra nada: el
# nombre en la biblioteca sigue siendo el canonico, y descargar dos veces la misma
# pista es redundante de todos modos.
#
# Es un `asyncio.Lock` porque las descargas son asincronas (el trabajo
# bloqueante de yt-dlp corre en un executor). El `_JOBS_LOCK` de arriba es un
# `threading.Lock` para el dict de jobs: son cosas distintas y no se mezclan.
# Ojo: NO llamar `_finish()` adentro de `_JOBS_LOCK` (no es reentrante) — el
# camino de espera de este lock solo publica `status`, nunca `_finish`.
# (`_LOCKS_POR_RUTA`/`_LOCKS_LOCK`/`_lock_de_ruta` quedan mas abajo, junto al
# resto de las constantes de pool/pruning de locks)


# ------------------------------------------------------------ URLs de YouTube
# En "YouTube" el usuario puede pegar el enlace en vez del titulo. Solo se
# aceptan hosts de YouTube: yt-dlp entiende cientos de sitios, pero el resto de
# la app (miniaturas, webpage_url, licencia) asume YouTube.
_YT_HOST = r"(?:https?://)?(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)/"
_YT_VIDEO = re.compile(
    _YT_HOST + r"(?:watch\?(?:.*&)?v=|shorts/|embed/|live/|v/)?([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])")
_YT_LIST = re.compile(_YT_HOST + r"playlist\?(?:.*&)?list=([A-Za-z0-9_-]+)")


def parse_youtube_url(q: str) -> str | None:
    """URL canonica si `q` es un enlace de YouTube; None si es texto.

    Un video con `&list=` se queda en el video: es lo que se estaba viendo al
    copiar el enlace. Solo una URL de playlist pura devuelve la playlist.
    """
    q = q.strip()
    if " " in q:
        return None
    m = _YT_VIDEO.match(q)
    if m:
        return f"https://www.youtube.com/watch?v={m.group(1)}"
    m = _YT_LIST.match(q)
    if m:
        return f"https://www.youtube.com/playlist?list={m.group(1)}"
    return None


def thumbnail_url(video_id: str) -> str:
    """hqdefault existe para todo video. Es 4:3 con franjas negras; la tarjeta
    lo recorta a 16:9, que es justo la imagen sin franjas."""
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


def identity_query(query: str | None, fallback: str) -> str:
    """Lo que se compara con el titulo real para el veredicto de identidad.

    Si se pego un enlace, se pidio ESE video: comparar la URL con su titulo
    daria siempre "no coincide". En ese caso manda el titulo del propio video.
    """
    if not query or parse_youtube_url(query):
        return fallback
    return query


def identity_reference(query: str | None, track: Track, fallback: str) -> str:
    """Contra que se compara el titulo real del video.

    Con ficha de iTunes se eligio ESA cancion: el video tiene que ser ella,
    aunque lo escrito fuera mas corto ("Radiohead Creep" para el "Creep
    (Acoustic)" elegido). Es lo que dice la ficha del archivo: «coincide con la
    ficha». Sin ficha (busqueda de YouTube) manda lo que se escribio. Un enlace
    pegado pide ESE video: sigue la regla de `identity_query`.
    """
    if query and parse_youtube_url(query):
        return fallback
    if track.extra.get("from_itunes") and track.title:
        return f"{track.artist or ''} {track.title}".strip()
    return identity_query(query, fallback)


def identity_best_reference(query: str | None, track: Track,
                            real_title: str | None, fallback: str) -> str:
    """La referencia de `identity_reference` o, si la ficha trae alias en otra
    escritura (storefront jp), la variante que mejor coincide con el titulo
    real. Juntar todo en una sola referencia no sirve, porque la similitud
    divide por la lista mas corta y las palabras de mas hundirian a un video
    titulado en la escritura de siempre.
    """
    from .identify import similarity
    refs = [identity_reference(query, track, fallback)]
    aliases = track.extra.get("aliases")
    if track.extra.get("from_itunes") and track.title and isinstance(aliases, dict):
        artistas = [track.artist or ""]
        titulos = [track.title]
        if isinstance(aliases.get("artist"), str):
            artistas.append(aliases["artist"])
        if isinstance(aliases.get("title"), str):
            titulos.append(aliases["title"])
        refs += [f"{a} {t}".strip() for a in artistas for t in titulos][1:]
    return max(refs, key=lambda r: similarity(r, real_title))


#: Por encima de esto se podan las libres (no tomadas) mas viejas: una sesion
#: que descarga un album de miles de pistas no deja crecer el dict para
#: siempre. Una lock TOMADA nunca se poda (ver abajo), asi que dos descargas
#: de la MISMA clave en curso siguen compartiendo la MISMA instancia.
_LOCKS_MAX = 512

_LOCKS_POR_RUTA: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, tuple[asyncio.Lock, float]]]" = (
    weakref.WeakKeyDictionary())
_LOCKS_LOCK = threading.Lock()


def _lock_de_ruta(clave: str) -> asyncio.Lock:
    """Lock de una clave de salida (la biblioteca, sin extension). Se crea una
    vez y se reusa.

    Es la identidad del archivo final: dos descargas que resuelven a la MISMA
    pista comparten esta clave y se serializan aunque cada una trabaje en su
    propia subcarpeta temporal.

    Atada al loop actual (como `_top_lock` en main.py), con un
    `WeakKeyDictionary`: un reinicio del loop (tests, un restart del server)
    no deja locks colgando de un loop que ya no existe. Ademas se poda cuando
    hay demasiadas sin uso (`_LOCKS_MAX`): antes el dict crecia sin limite "a
    proposito" (un par de entradas por pista descargada EN TODA LA SESION),
    que en una sesion larga de descargas masivas sí pesa.
    """
    loop = asyncio.get_running_loop()
    ahora = time.monotonic()
    with _LOCKS_LOCK:
        por_loop = _LOCKS_POR_RUTA.get(loop)
        if por_loop is None:
            por_loop = _LOCKS_POR_RUTA[loop] = {}
        entry = por_loop.get(clave)
        if entry is not None:
            por_loop[clave] = (entry[0], ahora)
            return entry[0]
        lock = asyncio.Lock()
        por_loop[clave] = (lock, ahora)
        if len(por_loop) > _LOCKS_MAX:
            libres = sorted(
                (k for k, (l, _) in por_loop.items()
                 if k != clave and not l.locked()),
                key=lambda k: por_loop[k][1])
            for k in libres[: len(por_loop) - _LOCKS_MAX]:
                del por_loop[k]
        return lock


def _purge_jobs(now: float | None = None) -> int:
    """Saca los jobs YA terminados hace rato. Devuelve cuantos saco.

    Solo toca estados finales (`_DONE_STATES`) con `finished_at` viejo: un job
    pending/downloading/processing nunca se purgea, asi que la UI puede seguir
    consultando su job_id por HTTP sin colgarse. Purgar es perezoso (llama
    new_job), no un thread que corre para siempre.
    """
    now = time.time() if now is None else now
    with _JOBS_LOCK:
        viejo = [jid for jid, j in JOBS.items()
                 if j.get("status") in _DONE_STATES
                 and j.get("finished_at") is not None
                 and now - j["finished_at"] > JOBS_TTL_S]
        for jid in viejo:
            del JOBS[jid]
    if viejo:
        log.info("purga de jobs: %d terminados de mas de %ds fuera", len(viejo),
                 int(JOBS_TTL_S))
    return len(viejo)


def _finish(job_id: str, **campos) -> None:
    """Marca el job como terminado y le clava el finished_at."""
    with _JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return
        job.update(campos)
        job["finished_at"] = time.time()


def new_job(title: str) -> str:
    """Crea un job y devuelve su id. Lo llama main.py ANTES de arrancar la
    descarga en background, para que la UI sepa que job_id hacer polling."""
    _purge_jobs()  # perezoso: aprovecho que se va a crear un job
    job_id = uuid.uuid4().hex[:8]
    with _JOBS_LOCK:
        # `phase` afina el estado para la UI: "preparing" (extraccion de
        # yt-dlp), "downloading", "converting" (ffmpeg) y "saving" (escritura
        # en la biblioteca). None mientras el job espera.
        JOBS[job_id] = {"status": "pending", "progress": 0.0,
                        "speed": None, "eta": None, "title": title,
                        "phase": None, "finished_at": None}
    return job_id


def ensure_job(job_id: str, title: str) -> None:
    """Crea (o reinicia) el job de un item de la cola al recargar/reintentar.

    Los jobs viven en memoria: despues de un reinicio la cola se recupera del
    JSON pero el dict JOBS esta vacio. Esta funcion deja el job en "pending"
    para que la ruta de progreso siga respondiendo con la misma forma de siempre.
    """
    with _JOBS_LOCK:
        JOBS[job_id] = {"status": "pending", "progress": 0.0,
                        "speed": None, "eta": None, "title": title,
                        "phase": None, "finished_at": None}


def key_base_for(track, media: str = "audio", height: int | None = None) -> str:
    """Clave de salida SIN extension: identidad del archivo y de la dedupe.

    La usa `download()` y tambien la cola para saber si dos items apuntan al
    mismo archivo (y fusionarlos) antes de arrancar ninguna descarga.
    """
    folder = safe_name(track.artist or "varios", 60)
    stem = safe_name(f"{track.artist} - {track.title}", 100)
    # Con una resolucion elegida, la clave lleva ` [Hp]`: asi dos alturas del
    # mismo video no comparten clave. El audio no tiene resolucion.
    if height is not None and media in ("both", "video"):
        stem = f"{stem} [{int(height)}p]"
    # `library_scan` deduce `has_audio` mirando si el stem termina asi.
    if media == "video":
        stem = f"{stem} (sin audio)"
    return f"{folder}/{stem}"


# ------------------------------------------------------------------- cancelar
class DownloadCancelledLocal(Exception):
    """Fallback cuando yt-dlp no expone `utils.DownloadCancelled` (tests)."""


def _cancelled_instance() -> BaseException:
    """Instancia de la excepcion que aborta una bajada desde el progress hook.

    yt-dlp documenta levantar `DownloadCancelled` desde un hook para cortar la
    descarga. En los tests offline el doble no trae `yt_dlp.utils`, asi que se
    cae al propio tipo; `download()` reconoce ambos para no confundirlos con un
    error de red.
    """
    try:
        from yt_dlp.utils import DownloadCancelled
        return DownloadCancelled()
    except Exception:
        return DownloadCancelledLocal()


def _es_cancel(error: BaseException) -> bool:
    """True si `error` es un aborto por cancelacion, no un fallo de descarga."""
    if isinstance(error, DownloadCancelledLocal):
        return True
    try:
        from yt_dlp.utils import DownloadCancelled
        return isinstance(error, DownloadCancelled)
    except Exception:
        return False


#: Prefijo de las carpetas de trabajo estables dentro de TEMP_DIR. El prefijo
#: distingue las nuestras de los `mkdtemp` del downloader comun.
_PARTIAL_PREFIX = "partial-"


def partial_dir_for(key_base: str) -> Path:
    """Carpeta de trabajo ESTABLE de una clave (para que continuedl reanude).

    Antes cada intento usaba un `mkdtemp` fresco, asi que un corte de red tiraba
    el .part y el reintento empezaba de cero. Ahora la ruta sale del sha1 de la
    clave: la misma pista siempre trabaja en la misma carpeta y yt-dlp puede
    seguir el .part que quedo. La carpeta se borra al terminar (exito/cancel),
    se conserva en error y se limpia por vejez al arrancar.
    """
    from .downloader import TEMP_DIR
    digest = hashlib.sha1(key_base.encode("utf-8")).hexdigest()
    return TEMP_DIR / f"{_PARTIAL_PREFIX}{digest}"


def cleanup_partials(ttl_s: float = 24 * 3600.0, now: float | None = None) -> int:
    """Borra carpetas de trabajo abandonadas hace mas de `ttl_s`. Devuelve cuantas."""
    from .downloader import TEMP_DIR
    if not TEMP_DIR.is_dir():
        return 0
    now = time.time() if now is None else now
    borradas = 0
    for folder in TEMP_DIR.iterdir():
        try:
            if (not folder.is_dir() or not folder.name.startswith(_PARTIAL_PREFIX)
                    or now - folder.stat().st_mtime <= ttl_s):
                continue
            shutil.rmtree(folder, ignore_errors=True)
            borradas += 1
        except OSError:
            continue
    return borradas


def _hay_parcial(work: Path) -> bool:
    """True si quedo algun archivo en la carpeta de trabajo (un .part sirve)."""
    try:
        return any(p.is_file() for p in work.iterdir())
    except OSError:
        return False


# ----------------------------------------------------- reintentos de descarga
# YouTube a veces contesta HTTP 403 al primer intento y el segundo anda (visto en
# un telefono real): las URLs de los formatos caducan o se rechazan al azar. Por
# eso un reintento rehace TODO (extract + download) para traer URLs nuevas.
# Esperas entre intentos; intentos totales = len(RETRY_DELAYS_S) + 1 = 3. Es un
# atributo del modulo para que los tests lo pisen con (0, 0) y no duerman.
RETRY_DELAYS_S: tuple[float, ...] = (1.0, 3.0)

# Errores que NUNCA se reintentan: otro intento da exactamente lo mismo. Se
# miran PRIMERO, porque un mensaje permanente puede traer tambien un "403".
_PERMANENT_MARKERS = (
    "video unavailable", "this video is unavailable", "private video",
    "video is private", "sign in", "members-only", "has been removed",
    "requested format is not available", "unsupported url", "is not a valid url",
    # DNS: sin red o sin nombre no se arregla esperando 1 s
    "no address associated with hostname", "getaddrinfo failed",
    "name or service not known", "temporary failure in name resolution",
    "nodename nor servname",
)
_TRANSIENT_RE = re.compile(
    r"http error (?:403|429|5\d\d)"
    r"|too many requests"
    r"|connection (?:reset|aborted)"
    r"|remote end closed"
    r"|incompleteread"
    r"|timed out|timeout"
    r"|winerror 10054")


def is_transient_error(error: BaseException | str) -> bool:
    """True si vale la pena reintentar: HTTP 403/429/5xx, corte o timeout.

    Funcion pura (solo mira el mensaje) para poder testearla sin yt-dlp. Un
    error permanente (video no disponible, privado, formato inexistente, DNS)
    devuelve False aunque el mensaje mencione tambien un 403.
    """
    msg = str(error).lower()
    if any(m in msg for m in _PERMANENT_MARKERS):
        return False
    if isinstance(error, (ConnectionResetError, ConnectionAbortedError, TimeoutError)):
        return True
    return bool(_TRANSIENT_RE.search(msg))


# --------------------------------------------------- runtime de JS y clientes
# YouTube exige resolver un reto de JavaScript para ciertos formatos. Sin un
# runtime de JS, yt-dlp avisa "No supported JavaScript runtime" y algunos
# clientes no devuelven formatos. `SPITIFO_QJS` apunta a un binario QuickJS
# (qjs): si el archivo existe se le pasa a yt-dlp tal cual. Sin la variable
# queda el default de yt-dlp (ninguno): no se inventa un runtime que no esta.
def qjs_path() -> str | None:
    """Ruta absoluta de `SPITIFO_QJS` si apunta a un archivo que existe."""
    valor = (os.getenv("SPITIFO_QJS") or "").strip()
    if not valor:
        return None
    ruta = Path(valor)
    return str(ruta.resolve()) if ruta.is_file() else None


def js_runtimes_opt() -> dict:
    """`{'quickjs': {'path': ...}}` si hay qjs; `{}` si no (default de yt-dlp)."""
    ruta = qjs_path()
    return {"quickjs": {"path": ruta}} if ruta else {}


def configured_js_runtime() -> str | None:
    """Nombre del runtime de JS configurado, para /api/health."""
    return "quickjs" if qjs_path() else None


#: Clientes de YouTube que yt-dlp prueba, en orden. `default` expande a la
#: lista propia de yt-dlp; los otros dos son los que hoy esquivan mejor el muro
#: sin cuenta. NO se quitan los defaults: se agregan.
PLAYER_CLIENTS = ("default", "android_vr", "web_embedded")


def extractor_args_opt(existing: dict | None = None) -> dict:
    """`extractor_args` con los clientes de YouTube, SIN pisar lo que ya haya.

    Se fusiona sobre `existing` (y sobre su `youtube`): si algo ya traia
    `player_client`, esos clientes se conservan y solo se completan los que
    falten.
    """
    args = dict(existing or {})
    youtube = dict(args.get("youtube") or {})
    clientes = list(youtube.get("player_client") or [])
    for cliente in PLAYER_CLIENTS:
        if cliente not in clientes:
            clientes.append(cliente)
    youtube["player_client"] = clientes
    args["youtube"] = youtube
    return args


def youtube_opts(base: dict | None = None) -> dict:
    """Opciones de yt-dlp para YouTube: runtime de JS + clientes de respaldo.

    Se usa en TODAS las construcciones de `YoutubeDL` que hablan con YouTube
    (buscar, resolver y descargar) para que la resiliencia sea la misma en el
    primer contacto que en la bajada.
    """
    opts = dict(base or {})
    jr = js_runtimes_opt()
    if jr:
        opts["js_runtimes"] = jr
    opts["extractor_args"] = extractor_args_opt(opts.get("extractor_args"))
    return opts


# ------------------------------------------------------- muro de verificacion
class BotCheckError(RuntimeError):
    """YouTube pidio verificar que no sos un bot y no hay cookies importadas.

    `code` viaja al job y a la respuesta para que la UI ofrezca importar un
    cookies.txt en lugar de un "fallo la descarga" generico.
    """

    code = "youtube_bot_check"


#: "Sign in to confirm you're not a bot", con comillas tipograficas incluidas.
_BOT_CHECK_RE = re.compile(
    r"sign in to confirm you|confirm you[\u2018\u2019']?re not a bot",
    re.IGNORECASE)


def is_bot_check_error(error: BaseException | str) -> bool:
    """True si el error es el muro de verificacion de YouTube. Funcion pura."""
    return bool(_BOT_CHECK_RE.search(str(error)))


# ------------------------------------------------------ formato de la descarga
def postprocessor_opts(fmt: str) -> list[dict]:
    """Postprocessors de yt-dlp para el `fmt` pedido.

    "original" usa preferredcodec "best": yt-dlp extrae la pista de audio a su
    contenedor natural SIN recodificar (opus -> .opus, aac -> .m4a, vorbis ->
    .ogg). m4a prefiere la pista AAC del origen, asi que tampoco recodifica
    cuando YouTube la publica. SOLO mp3 (una eleccion explicita del usuario)
    fuerza una conversion real, y su coste se avisa en Ajustes.
    """
    if fmt == "original":
        codec = "best"
    elif fmt in ("mp3", "m4a"):
        codec = fmt
    else:
        codec = "mp3"
    return [{"key": "FFmpegExtractAudio", "preferredcodec": codec,
             "preferredquality": "2"}]


def is_transcode(fmt: str, media: str = "audio") -> bool:
    """True si este trabajo quema CPU de verdad (conversion a mp3).

    La cola usa esto para separar el semaforo de red del de CPU: un album en
    m4a/original puede bajar varias pistas a la vez porque solo espera bytes;
    uno en mp3 comparte el limite de 2 transcodificaciones simultaneas.
    """
    return media == "audio" and (fmt not in ("original", "m4a"))


# ------------------------------------------------------------- tipo de media
#: Tipos de media validos. "audio" es la bajada de solo-audio de siempre;
#: "both" une video y audio en un mp4; "video" deja SOLO el stream de video.
MEDIA_KINDS = ("audio", "video", "both")

#: Sin AV1: se descarga bien, pero Chromium en Windows (WebView2) no lo
#: reproduce sin una extension del sistema, y el video quedaria negro.
_NO_AV1 = "[vcodec!^=av01]"

#: Audio para fmt="m4a": YouTube publica una pista AAC (formato 140) ademas de
#: la Opus. Pidiendo la AAC, FFmpegExtractAudio solo cambia el contenedor y no
#: recodifica: medido en PC, 0,13 s frente a 5,1 s de Opus -> AAC, y sin la
#: perdida de pasar de un formato con perdida a otro. Si no hay AAC, cae al
#: selector de siempre y se recodifica como antes.
M4A_AUDIO_SELECTOR = "bestaudio[ext=m4a]/bestaudio/best"

#: Timeout de la bajada de la miniatura: es un extra, no puede colgar el job.
THUMB_TIMEOUT_S = 15.0

#: Cuanto espera la descarga a las portadas antes de dar el tema por terminado.
#: Antes esperaba hasta 5 s por un JPEG que no hace falta para escuchar: ahora
#: se marca `done` y una portada lenta se puede backfill con «Buscar portadas».
COVER_WAIT_S = 1.0

#: Alturas (px) que acepta el picker de resolucion y el `height` del request.
MIN_HEIGHT = 144
MAX_HEIGHT = 4320


def _video_branches(height: int | None) -> list[str]:
    """Selectores de SOLO video, de mas a menos preferido.

    Dos decisiones que salieron de probarlo contra YouTube de verdad:
    - `bv` y no `bv*`: `bv*` tambien matchea los formatos que ya traen audio, y
      el 360p progresivo (formato 18) hoy responde 403. Los combinados quedan
      solo como ultimo recurso de "both".
    - Con `height`, la altura EXACTA va primero. Si el primer intento fuera el
      mp4/avc1 acotado con `<=`, pedir 1440p o 4K bajaria en silencio un 1080p
      avc1, porque YouTube no publica avc1 por encima de 1080p.
    """
    if height is None:
        # Lo mejor que haya (yt-dlp ordena por resolucion), sin AV1.
        return [f"bv{_NO_AV1}", "bv"]
    return [
        f"bv[height={height}][ext=mp4][vcodec^=avc1]",
        f"bv[height={height}]{_NO_AV1}",
        f"bv[height<={height}][ext=mp4][vcodec^=avc1]",
        f"bv[height<={height}]{_NO_AV1}",
        f"bv[height<={height}]",
    ]


def media_selector(media: str, height: int | None = None) -> str:
    """Cadena de `format` de yt-dlp para `media`, acotada a `height` si viene.

    Funcion PURA. "audio" es el selector de siempre y ignora `height`. "video"
    baja solo el stream de video (sin sonido). "both" suma el audio m4a (AAC, el
    que cabe en un mp4 en cualquier reproductor) y cae a Opus y, al final, a un
    archivo que ya traiga ambas pistas. No hay fallback silencioso a una altura
    MAYOR: si nada entra en el limite yt-dlp falla y el job lo reporta.
    """
    if media == "audio" or media not in MEDIA_KINDS:
        return "bestaudio/best"
    videos = _video_branches(height)
    if media == "video":
        return "/".join(videos)
    combinado = "b" if height is None else f"b[height<={height}]"
    ramas = [f"{v}+ba[ext=m4a]" for v in videos]
    ramas += [f"{v}+ba" for v in videos[-2:]]
    ramas.append(combinado)
    return "/".join(ramas)


def media_opts(media: str, fmt: str = "mp3", height: int | None = None) -> dict:
    """Opciones de yt-dlp (formato, merge y postprocessors) para `media`.

    Funcion PURA para poder testearla sin yt-dlp. `media="audio"` devuelve
    EXACTAMENTE lo de siempre: formato de solo-audio + FFmpegExtractAudio segun
    `fmt`. "both" une video+audio en mp4 SIN recodificar, asi que NO lleva el
    postprocessor de extraccion de audio. "video" baja solo el stream de video y
    no lleva postprocessors (no hay audio que extraer). Un `media` desconocido
    cae a "audio": la validacion del request es de la API.

    `height` solo aplica a video ("both"/"video"): con "audio" se ignora.

    Con "audio" y `fmt="m4a"` se prefiere la pista AAC del origen
    (`M4A_AUDIO_SELECTOR`), asi la conversion no recodifica.
    """
    elegido = media if media in MEDIA_KINDS else "audio"
    h = height if elegido in ("both", "video") else None
    if elegido == "audio" and fmt == "m4a":
        opts: dict = {"format": M4A_AUDIO_SELECTOR}
    else:
        opts = {"format": media_selector(elegido, h)}
    if elegido == "both":
        opts["merge_output_format"] = "mp4"
    opts["postprocessors"] = (postprocessor_opts(fmt) if elegido == "audio"
                              else [])
    return opts


# --------------------------------------------------- resoluciones de un video
def _resolution_label(height: int) -> str:
    """Etiqueta legible de una altura. Predecible: `f{h}p` salvo los extremos."""
    if height >= 4320:
        return "8K"
    if height >= 2160:
        return "4K"
    return f"{height}p"


def _es_storyboard(f: dict) -> bool:
    """True si el formato es un storyboard (slideshow de la miniatura)."""
    return (f.get("ext") == "mhtml"
            or "storyboard" in str(f.get("format_note") or "").lower())


def _rank_video(f: dict) -> tuple:
    """Clave de preferencia de un formato de video (mayor gana).

    Primero mp4 con `avc1` (compatible con todo), despues mas fps, despues mas
    tamano. El tamano usa `filesize` o, si falta, la estimacion.
    """
    avc1_mp4 = int(f.get("ext") == "mp4"
                   and str(f.get("vcodec") or "").startswith("avc1"))
    fps = f.get("fps") or 0
    size = f.get("filesize") or f.get("filesize_approx") or 0
    return (avc1_mp4, fps, size)


def summarize_formats(info: dict) -> list[dict]:
    """Resoluciones de video de `info`, deduplicadas por altura y de mayor a menor.

    Funcion PURA: entra el dict crudo de `extract_info`, sale lo que consume la
    UI. Solo mira formatos con stream de video y altura entera; descarta los
    storyboards/`mhtml` y las alturas irreales (< 144). Por altura se queda con
    el MEJOR candidato (`_rank_video`): el `filesize` es solo del video aunque
    el formato necesite un audio aparte.
    """
    mejores: dict[int, dict] = {}
    for f in info.get("formats") or []:
        vcodec = f.get("vcodec")
        if vcodec in (None, "none"):
            continue
        if _es_storyboard(f):
            continue
        height = f.get("height")
        if not isinstance(height, int) or isinstance(height, bool):
            continue
        if height < MIN_HEIGHT:
            continue
        actual = mejores.get(height)
        if actual is None or _rank_video(f) > _rank_video(actual):
            mejores[height] = f

    def fps_redondeado(v) -> int:
        return int(round(v)) if isinstance(v, (int, float)) else 0

    out = []
    for height in sorted(mejores, reverse=True):
        f = mejores[height]
        dr = f.get("dynamic_range")
        out.append({
            "height": height,
            "label": _resolution_label(height),
            "fps": fps_redondeado(f.get("fps")),
            "ext": f.get("ext"),
            "filesize": f.get("filesize") or f.get("filesize_approx") or None,
            "hdr": bool(dr) and str(dr).upper() != "SDR",
        })
    return out


# Cache en memoria de las resoluciones por id de video: reabrir el picker del
# mismo video no puede volver a golpear YouTube (el probe tarda segundos). 5
# minutos y 64 entradas alcanzan para una sesion de uso; el lock es porque el
# endpoint puede correr en varios hilos. `clear_formats_cache()` es para tests.
FORMATS_TTL_S = 300.0
FORMATS_MAX = 64
_FORMATS_CACHE: dict[str, tuple[float, dict]] = {}
_FORMATS_LOCK = threading.Lock()


def clear_formats_cache() -> None:
    """Vacia la cache de resoluciones (los tests la usan entre casos)."""
    with _FORMATS_LOCK:
        _FORMATS_CACHE.clear()


def _formats_cache_get(video_id: str, now: float | None = None) -> dict | None:
    now = time.time() if now is None else now
    with _FORMATS_LOCK:
        hit = _FORMATS_CACHE.get(video_id)
        if hit is None:
            return None
        cuando, payload = hit
        if now - cuando > FORMATS_TTL_S:
            del _FORMATS_CACHE[video_id]
            return None
        return payload


def _formats_cache_put(video_id: str, payload: dict,
                       now: float | None = None) -> None:
    now = time.time() if now is None else now
    with _FORMATS_LOCK:
        _FORMATS_CACHE[video_id] = (now, payload)
        # Acotada: si se paso, se van los mas viejos.
        if len(_FORMATS_CACHE) > FORMATS_MAX:
            viejos = sorted(_FORMATS_CACHE.items(), key=lambda kv: kv[1][0])
            for clave, _ in viejos[: len(_FORMATS_CACHE) - FORMATS_MAX]:
                del _FORMATS_CACHE[clave]


def bot_check_error() -> BotCheckError:
    """El mismo mensaje/codigo que publica la descarga cuando el muro persiste."""
    return BotCheckError(
        "YouTube pidio confirmar que no sos un bot. "
        "Importa un cookies.txt desde la configuracion y reintenta.")


async def probe_info(url: str, format: str | None = None) -> dict:
    """`extract_info(url, download=False)` con el manejo de cookies de la descarga.

    Mismo ultimo recurso que `YtDlpSource.download`: ante el muro de verificacion
    se reintenta UNA vez con las cookies importadas (copia plana temporal) y, si
    sigue, se levanta `BotCheckError` para que la API conteste 502 con el codigo.
    `format` permite pedir "bestaudio" para el streaming, que necesita la URL del
    formato sin bajarlo.

    Acotado a `PROBE_TIMEOUT_S` en total (extraccion + el reintento con
    cookies, si hace falta): antes esta funcion no tenia deadline propio, asi
    que `/api/formats` (via `video_formats`) podia quedar esperando para
    siempre a un YouTube que nunca contesta. `stream.py` ya envuelve SU
    llamada con el mismo limite (`FULL_TIMEOUT_S`); envolverlo tambien aca
    protege al resto de los que llaman a `probe_info` directo.
    """
    try:
        return await asyncio.wait_for(_probe_info_sin_limite(url, format),
                                      PROBE_TIMEOUT_S)
    except asyncio.TimeoutError as e:
        log.warning("ytdlp probe_info: %s tardo mas de %.0fs", url, PROBE_TIMEOUT_S)
        raise RuntimeError(f"yt-dlp: timeout tras {PROBE_TIMEOUT_S:.0f}s") from e


async def _probe_info_sin_limite(url: str, format: str | None = None) -> dict:
    import yt_dlp
    opts = youtube_opts({"quiet": True, "no_warnings": True, "skip_download": True,
                         "socket_timeout": 30, "retries": 1})
    if format:
        opts["format"] = format

    def _run(cookiefile: str | None = None):
        o = dict(opts)
        if cookiefile:
            o["cookiefile"] = cookiefile
        with yt_dlp.YoutubeDL(o) as ydl:
            return ydl.extract_info(url, download=False)

    try:
        return await run_ytdlp(_run)
    except Exception as e:
        if not is_bot_check_error(e):
            raise
        from . import youtube_cookies
        from .downloader import TEMP_DIR
        texto = youtube_cookies.load_text()
        if not texto:
            raise bot_check_error() from e
        log.info("ytdlp: probe de formatos reintenta con las cookies importadas")
        with youtube_cookies.plaintext_tempfile(texto, TEMP_DIR) as cookiefile:
            try:
                return await run_ytdlp(_run, str(cookiefile))
            except Exception as e2:
                if is_bot_check_error(e2):
                    raise bot_check_error() from e2
                raise


async def video_formats(url: str, video_id: str) -> dict:
    """Payload de `/api/formats` de un video, con cache de 5 min por id.

    `video_id` es la clave de cache (el id de 11 caracteres); `url` la usa el
    probe de yt-dlp.
    """
    hit = _formats_cache_get(video_id)
    if hit is not None:
        return hit
    info = await probe_info(url) or {}
    dur = info.get("duration")
    payload = {
        "id": info.get("id") or video_id,
        "title": info.get("title") or "",
        "duration_s": (int(dur) if isinstance(dur, (int, float))
                       and not isinstance(dur, bool) else None),
        "resolutions": summarize_formats(info),
    }
    _formats_cache_put(video_id, payload)
    return payload


def thumb_sidecar_key(key: str) -> str:
    """Clave del sidecar `.jpg` de una clave de media (mismo nombre, otra ext).

    Sobre POSIX (`/`): en Windows `Path` metería backslashes y la clave no
    coincidiria con la que espera `library_scan`.
    """
    nombre = key.rsplit("/", 1)[-1]
    base = key[: len(key) - len(nombre)] + (
        nombre.rsplit(".", 1)[0] if "." in nombre else nombre)
    return base + ".jpg"


async def fetch_thumb(video_id: str | None, key: str, work: Path) -> str | None:
    """Baja la miniatura del video y la guarda al lado de `key`. Best effort.

    Best effort de verdad: una miniatura que no llega NUNCA tiene que tumbar la
    descarga, asi que cualquier fallo se loguea y devuelve None. Usa httpx (el
    cliente que ya usa el proyecto) y timeout corto, sin ffmpeg: la futura build
    de ffmpeg sera solo de audio, sin codecs de imagen.
    """
    if not video_id:
        return None
    thumb_key = thumb_sidecar_key(key)
    try:
        import httpx  # import perezoso: solo hace falta para la miniatura
        from .storage import get_storage
        url = thumbnail_url(video_id)
        timeout = httpx.Timeout(THUMB_TIMEOUT_S)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True,
                                     headers={"User-Agent": USER_AGENT}) as c:
            r = await c.get(url)
            r.raise_for_status()
            data = r.content
        tmp = work / f".thumb-{uuid.uuid4().hex[:8]}.jpg"
        tmp.write_bytes(data)
        await run_storage(get_storage().put_file, thumb_key, tmp)
        return thumb_key
    except Exception as e:
        log.warning("ytdlp: no se pudo bajar la miniatura de %s: %s", video_id, e)
        return None


def pick_output(found: list[Path], fmt: str, media: str = "audio") -> Path | None:
    """Elige el archivo final entre los `<stem>.*` que quedaron en la carpeta.

    Es el fallback para cuando yt-dlp no devuelve `filepath`. Tiene que
    respetar el `fmt` pedido: con un orden fijo, un .mp3 viejo en la carpeta
    ganaba siempre y pedir m4a reportaba el nombre/tamano del .mp3. Con
    "original" no hay una extension esperada (depende del codec de origen):
    gana cualquier extension de audio, y entre varias, la mas reciente (el
    archivo que se acaba de escribir). Lo que no es audio (.webm intermedio,
    .part) va al final.

    Con `media` de video ("both"/"video") prefieren las extensiones de video:
    asi un intermedio de audio que quedo en la carpeta no le gana al archivo
    final.
    """
    if media in ("both", "video"):
        rank = dict.fromkeys(VIDEO_EXTS, 0)
    elif fmt in ("mp3", "m4a"):
        want = "." + fmt
        other = ".m4a" if want == ".mp3" else ".mp3"
        rank = {want: 0, other: 1}
    else:
        rank = dict.fromkeys(AUDIO_EXTS, 0)

    def clave(p: Path):
        try:
            mtime = p.stat().st_mtime
        except OSError:
            mtime = 0.0
        return (rank.get(p.suffix.lower(), 9), -mtime)

    ordenados = sorted(found, key=clave)
    return ordenados[0] if ordenados else None


# ------------------------------------------- extraccion adelantada (warm-up)
# De los ~6 s que tarda bajar una cancion, ~3 s son la extraccion de yt-dlp
# (pagina, player, formatos), y la red apenas medio segundo. La UI avisa con
# POST /api/download/warm cuando es probable que se descargue un video (abrir
# la ficha, primeros resultados): la extraccion corre en background y la
# descarga la reutiliza con `process_ie_result`. Se guarda el resultado SIN
# procesar (`process=False`): la seleccion de formato la hace la descarga con
# sus propias opciones (audio, m4a, video...).
#: Cuanto vale una extraccion adelantada. Las URLs de formato de YouTube
#: caducan a las ~6 h; 15 min cubre "abrir la ficha y decidirse" con margen.
WARM_TTL_S = 900.0
#: Entradas guardadas como mucho (cada una pesa unos cientos de KB).
WARM_MAX = 16
#: Extracciones en curso a la vez: no se le puede robar la red a la descarga.
WARM_PARALLEL = 3
#: Cuanto espera una descarga a una extraccion adelantada que todavia corre.
#: Pasado eso extrae por su cuenta, como antes.
WARM_WAIT_S = 20.0
_WARM: dict[str, tuple[float, dict]] = {}
_WARM_TASKS: dict[str, asyncio.Task] = {}
_WARM_LOCK = threading.Lock()


def clear_warm_cache() -> None:
    """Vacia las extracciones adelantadas (los tests la usan entre casos)."""
    with _WARM_LOCK:
        _WARM.clear()


def _warm_get(url: str, now: float | None = None) -> dict | None:
    now = time.time() if now is None else now
    with _WARM_LOCK:
        hit = _WARM.get(url)
        if hit is None:
            return None
        if now - hit[0] > WARM_TTL_S:
            del _WARM[url]
            return None
        return hit[1]


def _warm_put(url: str, raw: dict, now: float | None = None) -> None:
    now = time.time() if now is None else now
    with _WARM_LOCK:
        _WARM[url] = (now, raw)
        if len(_WARM) > WARM_MAX:
            viejos = sorted(_WARM.items(), key=lambda kv: kv[1][0])
            for clave, _ in viejos[: len(_WARM) - WARM_MAX]:
                del _WARM[clave]


def _warm_take(url: str) -> dict | None:
    """Saca la extraccion de la cache: se usa UNA vez. Una segunda descarga
    del mismo video extrae de nuevo, con URLs de formato frescas."""
    raw = _warm_get(url)
    if raw is not None:
        with _WARM_LOCK:
            _WARM.pop(url, None)
    return raw


def _extract_raw(url: str) -> dict:
    import yt_dlp
    opts = youtube_opts({"quiet": True, "no_warnings": True, "skip_download": True,
                         "socket_timeout": 30, "retries": 1})
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(url, download=False, process=False)


def warm(url: str) -> bool:
    """Arranca en background la extraccion de `url` (canonica, de video).

    Se llama desde el loop de asyncio. No hace nada si ya esta en cache, si ya
    corre o si hay `WARM_PARALLEL` en curso. Un fallo (el muro de verificacion
    incluido) solo se registra: la descarga extraera por su cuenta y manejara
    las cookies como siempre. Devuelve si arranco una extraccion.
    """
    if url in _WARM_TASKS or len(_WARM_TASKS) >= WARM_PARALLEL:
        return False
    if _warm_get(url) is not None:
        return False

    async def _job():
        try:
            raw = await run_ytdlp(_extract_raw, url)
            if raw:
                _warm_put(url, raw)
        except Exception as e:
            log.info("ytdlp warm fallo (la descarga extraera de nuevo): %s", e)
        finally:
            _WARM_TASKS.pop(url, None)

    _WARM_TASKS[url] = asyncio.create_task(_job())
    return True


async def warmed_info(url: str, wait: float = WARM_WAIT_S) -> dict | None:
    """La extraccion adelantada de `url`, si la hay; espera a la que este en
    curso hasta `wait` segundos. None si no hay: la descarga extrae sola."""
    task = _WARM_TASKS.get(url)
    if task is not None:
        try:
            await asyncio.wait_for(asyncio.shield(task), wait)
        except Exception:
            pass
    return _warm_take(url)


# ------------------------------------------------- instancias para buscar
#: YoutubeDL listos para la busqueda del matcher (modo Musica). Construir uno
#: por busqueda costaba ~0,5 s: la instancia, los certificados y una conexion
#: nueva con youtube.com. YoutubeDL no es thread-safe, asi que cada busqueda
#: se lleva uno del pool y lo devuelve al terminar; uno que fallo se descarta.
_SEARCH_POOL: queue.Queue = queue.Queue(maxsize=3)

#: Admite como mucho `_SEARCH_POOL.maxsize` extracciones de `search_candidates`
#: a la vez: antes de esto, `_take_search_ydl()` construia una instancia NUEVA
#: en cuanto el pool se vaciaba (cualquier concurrencia por encima de 3 creaba
#: YoutubeDL de mas, cada una con su propia conexion TLS a youtube.com). El
#: `priority=True` de un tap del usuario (main.py) salta el limite de
#: concurrencia de la ruta, pero sigue esperando ACA: el pool de instancias
#: nunca se desborda, taps repetidos incluidos. Atado al loop actual, como
#: `_search_single_sem` en main.py: un Semaphore con esperas de OTRO loop
#: revienta ("attached to a different loop") y los tests corren cada uno en
#: su propio `asyncio.run`.
_SEARCH_POOL_SEMS: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = (
    weakref.WeakKeyDictionary())


def _search_pool_sem() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    sem = _SEARCH_POOL_SEMS.get(loop)
    if sem is None:
        sem = _SEARCH_POOL_SEMS[loop] = asyncio.Semaphore(_SEARCH_POOL.maxsize)
    return sem


#: El semaforo de arriba acota cuantas llamadas ENTRAN a la vez, pero un
#: timeout libera su cupo mientras el hilo de abajo sigue corriendo con una
#: instancia todavia prestada (ver el comentario en `search_candidates`): sin
#: este contador, una racha de timeouts seguida de nuevas busquedas podia
#: volver a crear instancias de mas, justo el bug que este pool existe para
#: evitar. `_SEARCH_INSTANCES_ALIVE` cuenta instancias VIVAS (creadas y no
#: cerradas), nunca mas de `_SEARCH_POOL.maxsize`: una nueva solo se crea
#: mientras haya margen bajo ese tope; si no hay margen, se espera (bloqueante,
#: pero siempre dentro de un hilo de `YTDLP_EXECUTOR`, nunca en el loop) a que
#: alguna instancia vuelva.
_SEARCH_INSTANCES_ALIVE = 0
_SEARCH_INSTANCES_LOCK = threading.Lock()


def _close_quietly(ydl) -> None:
    global _SEARCH_INSTANCES_ALIVE
    try:
        ydl.close()
    except Exception:
        pass
    with _SEARCH_INSTANCES_LOCK:
        _SEARCH_INSTANCES_ALIVE -= 1


def _take_search_ydl():
    global _SEARCH_INSTANCES_ALIVE
    try:
        return _SEARCH_POOL.get_nowait()
    except queue.Empty:
        pass
    with _SEARCH_INSTANCES_LOCK:
        if _SEARCH_INSTANCES_ALIVE < _SEARCH_POOL.maxsize:
            _SEARCH_INSTANCES_ALIVE += 1
            crear = True
        else:
            crear = False
    if crear:
        import yt_dlp
        return yt_dlp.YoutubeDL(youtube_opts({
            "quiet": True, "no_warnings": True, "skip_download": True,
            "extract_flat": "in_playlist", "socket_timeout": 30, "retries": 1,
        }))
    # Ya hay `maxsize` instancias vivas y todas prestadas (p. ej. una
    # extraccion que vencio su timeout pero sigue corriendo en su hilo):
    # esperar a que alguna vuelva, en vez de crear una de mas.
    return _SEARCH_POOL.get()


def _give_back_search_ydl(ydl) -> None:
    try:
        _SEARCH_POOL.put_nowait(ydl)
    except queue.Full:
        _close_quietly(ydl)


def prewarm_search() -> None:
    """Deja una instancia lista con la conexion a youtube.com abierta.

    La primera busqueda en modo Musica pagaba ademas importar yt-dlp (~1 s en
    el PC, mas en el telefono). Se llama en un hilo unos segundos despues de
    arrancar; un fallo solo se registra y la busqueda construye la suya.
    """
    from yt_dlp.networking import Request
    ydl = _take_search_ydl()
    try:
        ydl.urlopen(Request("https://www.youtube.com/generate_204")).read()
    except Exception as e:
        log.info("ytdlp: no se pudo preparar la busqueda: %s", e)
    _give_back_search_ydl(ydl)


class YtDlpSource(Source):
    name = "ytdlp"

    def available(self) -> bool:
        return os.getenv("YTDLP_ENABLED", "0") == "1"

    # ---------------------------------------------------------------- search
    async def search_candidates(self, q: str, limit: int = 20) -> list[dict]:
        """Busca cruda en YouTube, sin filtrar por 'musical'. La usa el matcher."""

        def _run():
            ydl = _take_search_ydl()
            try:
                data = ydl.extract_info(f"ytsearch{limit}:{q}", download=False)
            except Exception:
                _close_quietly(ydl)
                raise
            _give_back_search_ydl(ydl)
            return data

        # El semaforo (tope = tamano del pool) va AFUERA del wait_for: si el
        # tiempo de espera vence, se libera y la extraccion que sigue
        # corriendo en su hilo se encarga sola de devolver o cerrar su
        # instancia (ver `_run`); el pool nunca queda con una instancia
        # "prestada y perdida".
        async with _search_pool_sem():
            try:
                data = await asyncio.wait_for(
                    run_ytdlp(_run), YTDLP_CALL_TIMEOUT_S)
            except asyncio.TimeoutError:
                log.warning("ytdlp search_candidates: %r tardo mas de %.0fs", q,
                            YTDLP_CALL_TIMEOUT_S)
                raise
        return [e for e in (data or {}).get("entries", []) or [] if e]

    async def search(self, q: str, limit: int = 20) -> list[Track]:
        if not self.available():
            return []
        import yt_dlp
        url = parse_youtube_url(q)
        opts = youtube_opts({
            "quiet": True, "no_warnings": True, "skip_download": True,
            "extract_flat": "in_playlist", "socket_timeout": 30, "retries": 1,
            "noplaylist": True, "playlistend": limit,
        })

        def _run():
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(url or f"ytsearch{limit}:{q}", download=False)

        try:
            data = await asyncio.wait_for(run_ytdlp(_run), YTDLP_CALL_TIMEOUT_S)
        except asyncio.TimeoutError as e:
            log.warning("ytdlp search: %r tardo mas de %.0fs", q, YTDLP_CALL_TIMEOUT_S)
            raise RuntimeError(f"yt-dlp: timeout tras {YTDLP_CALL_TIMEOUT_S:.0f}s") from e
        except Exception as e:
            log.warning("ytdlp search fallo: %s", e)
            raise RuntimeError(f"yt-dlp: {e}")

        data = data or {}
        # Un video suelto viene sin "entries": es el propio resultado.
        entries = data.get("entries") if "entries" in data else [data]
        out = []
        for e in entries or []:
            if not e or not e.get("id"):
                continue
            title = e.get("title") or ""
            uploader = e.get("uploader") or e.get("channel") or ""
            # Con un enlace pegado no se filtra "lo que no parece musica": el
            # usuario eligio ese video a proposito.
            if not url and not looks_like_music(title, uploader):
                continue
            out.append(Track(
                source=self.name,
                source_id=e["id"],
                title=title,
                artist=uploader,
                duration_s=e.get("duration"),
                artwork_url=thumbnail_url(e["id"]),
                extra={
                    "webpage_url": f"https://www.youtube.com/watch?v={e['id']}",
                    "relevance": 1.0 if url else round(relevance(q, title, uploader), 2),
                },
                license="ToS de YouTube (uso personal, riesgo legal)",
            ))
        return out

    # --------------------------------------------------------------- resolve
    async def resolve(self, track: Track, query: str | None = None) -> Track:
        """Obtiene la URL de audio (m4a/webm) del video para poder descargarlo."""
        import yt_dlp
        url = track.extra.get("webpage_url")
        if not url:
            raise LookupError("falta webpage_url")
        opts = youtube_opts({"quiet": True, "no_warnings": True,
                             "skip_download": True, "socket_timeout": 30,
                             "retries": 1})

        def _run():
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
                fmts = info.get("formats", [])
                audio = [f for f in fmts
                         if f.get("acodec") not in (None, "none")
                         and f.get("vcodec") == "none"]
                if audio:
                    best = max(audio, key=lambda f: f.get("abr") or 0)
                else:
                    best = info  # sin solo-audio: usar el stream completo
                return info, best

        try:
            info, best = await asyncio.wait_for(run_ytdlp(_run), YTDLP_CALL_TIMEOUT_S)
        except asyncio.TimeoutError as e:
            log.warning("ytdlp resolve: %s tardo mas de %.0fs", url, YTDLP_CALL_TIMEOUT_S)
            raise RuntimeError(f"yt-dlp: timeout tras {YTDLP_CALL_TIMEOUT_S:.0f}s") from e
        except Exception as e:
            log.warning("ytdlp resolve fallo: %s", e)
            raise RuntimeError(f"yt-dlp: {e}")

        track.audio_url = best.get("url") or info.get("url")
        track.extra["format"] = (best.get("ext") or "webm").upper()
        track.extra["abr"] = best.get("abr")
        track.extra["filesize_mb"] = round((best.get("filesize") or 0) / 1_048_576, 1)
        track.license = "ToS de YouTube (uso personal, riesgo legal)"

        # identidad real del video
        real_title = info.get("title")
        if real_title:
            from .identify import verdict
            state, label = verdict(
                identity_best_reference(query, track, real_title, real_title),
                real_title)
            track.extra["real_title"] = real_title
            track.extra["real_artist"] = info.get("uploader")
            track.extra["match"] = state
            track.extra["match_label"] = label
            track.extra["duration_s"] = info.get("duration")
        return track

    # -------------------------------------------------------------- download
    async def download(self, track: Track, fmt: str = "mp3",
                       job_id: str | None = None,
                       query: str | None = None,
                       media: str = "audio",
                       height: int | None = None,
                       cancel: threading.Event | None = None,
                       on_progress: Callable[[], None] | None = None) -> dict:
        """Descarga via yt-dlp (usa su postprocessor de ffmpeg) con progreso.

        No reutiliza downloader.download_track porque yt-dlp gestiona su propio
        pipeline de formatos + postprocess. `job_id` lo puede crear el caller
        (main.py) para que la UI sepa que id hacer polling desde el arranque.

        `query` es lo que el usuario escribio. Se usa DESPUES de descargar,
        contra el titulo real del video, para publicar el veredicto de
        identidad en el job: sin esto la UI recibe status=done sin `match` y
        nunca puede avisar "esto no es lo que buscabas".

        `media` decide que se baja: "audio" (default, comportamiento de
        siempre), "both" (video+audio unidos en mp4) o "video" (solo el stream
        de video, sin sonido). El resultado suma `kind`, `thumb_key` y `height`.

        `height` (video/both) acota la resolucion a esa altura o menos; con
        "audio" se ignora. Cuando viene, la clave de salida lleva ` [Hp]` para
        que dos resoluciones del mismo video convivan en la biblioteca.

        `cancel` es un Event que el progress hook mira para abortar de golpe
        (levanta DownloadCancelled) y `on_progress` avisa a la cola para que
        persista el avance como maximo una vez por segundo.
        """
        import yt_dlp
        # import perezoso: downloader importa sources, que importa ytdlp_source
        from .covers import fetch_itunes_covers
        from .downloader import (TEMP_DIR, _write_tags, build_download_record,
                                 thumb_small_sidecar)
        from .identify import verdict
        from .storage import get_storage
        url = track.extra.get("webpage_url")
        if not url:
            raise ValueError("ytdlp: falta webpage_url")

        media = media if media in MEDIA_KINDS else "audio"
        kind = "video" if media in ("both", "video") else "audio"

        if job_id is None:
            job_id = new_job(track.title)

        # Clave de salida SIN extension: identidad del archivo final, del lock
        # por ruta y de la dedupe de la cola. La fabrica `key_base_for` es la
        # misma que usa main.py antes de encolar.
        key_base = key_base_for(track, media, height)
        folder = key_base.split("/", 1)[0]
        stem = key_base.rsplit("/", 1)[-1]

        # yt-dlp IGNORA `paths` cuando el outtmpl es absoluto, asi que el outtmpl
        # va RELATIVO y `paths.home`/`paths.temp` apuntan a la MISMA carpeta de
        # trabajo: asi los .part y los intermedios .webm nunca caen en la
        # biblioteca. La carpeta es ESTABLE por clave (no un mkdtemp fresco):
        # con continuedl un corte de red deja el .part y el reintento sigue
        # desde ahi. El archivo terminado entra con `put_file`, no con yt-dlp.
        # Vive directo en TEMP_DIR con prefijo `partial-` para no confundirla
        # con los temporales del downloader comun.
        work = partial_dir_for(key_base)
        work.mkdir(parents=True, exist_ok=True)
        outtmpl = f"{stem}.%(ext)s"
        paths = {"home": str(work), "temp": str(work)}

        state = {"total": None, "downloaded": 0, "ultimo_intento": False}
        cancel = cancel if cancel is not None else threading.Event()

        def _check_cancel():
            if cancel.is_set():
                raise _cancelled_instance()

        def hook(d):
            # Aborto real: el hook corre en el thread de yt-dlp, asi que este
            # check corta la bajada aunque el event loop este esperando el
            # executor. Es la forma documentada de cancelar un download.
            _check_cancel()
            estado = d["status"]
            with _JOBS_LOCK:
                if estado == "downloading":
                    total = d.get("total_bytes") or d.get("total_bytes_estimate")
                    got = d.get("downloaded_bytes") or 0
                    if total:
                        state["total"] = total
                        JOBS[job_id]["progress"] = round(got / total * 100, 1)
                    JOBS[job_id]["downloaded_bytes"] = got
                    JOBS[job_id]["speed"] = d.get("speed")
                    JOBS[job_id]["eta"] = d.get("eta")
                    JOBS[job_id]["phase"] = "downloading"
                elif estado == "finished":
                    JOBS[job_id]["status"] = "processing"
                    JOBS[job_id]["phase"] = "converting"
            if estado == "error" and state["ultimo_intento"]:
                # FUERA del with de arriba: _finish toma el lock y Lock no es
                # reentrante, asi que llamarlo adentro cuelga el hook.
                # Solo en el ULTIMO intento: antes de eso el job sigue
                # "downloading" y el reintento puede salvarlo.
                _finish(job_id, status="error")
            # Aviso a la cola FUERA del lock (get_job lo vuelve a tomar).
            if on_progress is not None:
                on_progress()

        opts = youtube_opts({
            "quiet": True, "no_warnings": True, "noprogress": True,
            "outtmpl": outtmpl,
            "paths": paths,
            "progress_hooks": [hook],
            "socket_timeout": 60, "retries": 2,
            "overwrites": True,
            "continuedl": True,
            **media_opts(media, fmt, height),
        })

        def _run(cookiefile: str | None = None, raw: dict | None = None):
            # `cookiefile` solo llega en el reintento del muro de verificacion:
            # va a una COPIA plana en un temporal, nunca al sobre cifrado.
            # `raw` es la extraccion adelantada (`warmed_info`): con ella se
            # salta la extraccion y solo se elige formato y se baja.
            _check_cancel()
            o = dict(opts)
            if cookiefile:
                o["cookiefile"] = cookiefile
            with yt_dlp.YoutubeDL(o) as ydl:
                if raw is not None:
                    info = ydl.process_ie_result(raw, download=True)
                else:
                    info = ydl.extract_info(url, download=True)
                # Con FFmpegExtractAudio, `info['filepath']` viene None: yt-dlp
                # lo limpia tras el postprocess. NO usar prepare_filename()
                # aqui: devuelve el nombre con la extension del stream ORIGINAL
                # (webm/opus), no la del postprocess (mp3), asi que no matchea.
                # El outtmpl ya se construyo con `stem`, asi que el archivo
                # final es work/<stem>.<ext>. Se busca por glob para tolerar
                # cualquier sanitize extra que haya hecho yt-dlp.
                fp = info.get("filepath")
                if not fp or not Path(fp).exists():
                    # Ver `pick_output`: respeta el `fmt` pedido y, con
                    # "original", acepta la extension natural del audio
                    # (.opus, .m4a, .ogg...).
                    cand = pick_output(
                        list(work.glob(glob.escape(stem) + ".*")), fmt, media)
                    if cand is not None:
                        fp = str(cand)
                return info, fp

        # Una descarga por clave de salida (ver `_lock_de_ruta`). Si otro job ya
        # esta bajando ESTA pista, este espera en vez de chocar: se publica
        # "pending" para que la UI no diga "Descargando, 0%" mientras espera.
        lock = _lock_de_ruta(key_base)
        if lock.locked():
            with _JOBS_LOCK:
                JOBS[job_id]["status"] = "pending"

        cover_task: asyncio.Task | None = None
        exito = False
        cancelado = False

        def _preparar_reintento():
            """Vuelve a estado de bajada, SIN borrar el avance si quedo un .part.

            Con continuedl un corte de red deja el parcial en la carpeta estable:
            reiniciar el progress a 0 en ese caso es la mentira que reportaban
            los usuarios ("reintenta desde cero"). Si no quedo nada, si se
            reinicia como siempre.
            """
            state["total"] = None
            hay = _hay_parcial(work)
            with _JOBS_LOCK:
                JOBS[job_id].update(
                    status="downloading",
                    phase="downloading" if hay else "preparing",
                    progress=(JOBS[job_id].get("progress") if hay else 0.0),
                    speed=None, eta=None, downloaded_bytes=0)

        # El lock cubre tambien `_write_tags` y `put_file`: si se soltara antes,
        # el otro job podria empezar a reescribir el archivo mientras mutagen lo
        # tiene abierto. La LIMPIEZA va dentro del lock: si otra descarga de la
        # misma clave esta esperando, no le puede borrar la carpeta debajo.
        async with lock:
            # Cancelado mientras esperaba el lock: se va sin bajar nada.
            _check_cancel()
            # Otra descarga de la MISMA clave pudo borrar la carpeta al terminar
            # mientras esperabamos el lock. La recreamos: esta bajada arranca
            # limpia (o encuentra el .part de un error previo).
            work.mkdir(parents=True, exist_ok=True)
            try:
                with _JOBS_LOCK:
                    JOBS[job_id]["status"] = "downloading"
                    JOBS[job_id]["phase"] = "preparing"

                # Las portadas de iTunes no dependen del audio: se piden mientras
                # yt-dlp baja, y la descarga no espera a un CDN lento al final.
                if kind == "audio" and track.extra.get("from_itunes"):
                    cover_task = asyncio.create_task(
                        fetch_itunes_covers(track.artwork_url, work))

                # Con extraccion adelantada se baja directo. Si eso falla por lo
                # que sea, no cuenta como intento: se sigue por el camino de
                # siempre, que extrae de cero con URLs de formato nuevas.
                info = fp = None
                raw = await warmed_info(parse_youtube_url(url) or url)
                if raw is None and kind == "audio":
                    # Sin extraccion adelantada, el audio sale por el camino
                    # rapido del streaming (~0,2 s en vez de ~2 s). Si no hay o
                    # la bajada con ella falla, se extrae como siempre (abajo).
                    from . import stream
                    raw = await stream.fast_raw(parse_youtube_url(url) or url)
                if raw is not None:
                    try:
                        info, fp = await run_ytdlp(_run, None, raw)
                    except Exception as e:
                        if _es_cancel(e):
                            raise
                        log.info("ytdlp: fallo la bajada con la extraccion "
                                 "adelantada, se extrae de nuevo: %s", e)
                        info = fp = None
                        _preparar_reintento()

                # Reintentos: ante un error transitorio se rehace TODO (extract +
                # download) para traer URLs de formato nuevas. El job sigue
                # "downloading" entre intentos y recien pasa a error tras el ultimo.
                delays = tuple(RETRY_DELAYS_S)
                intentos = len(delays) + 1
                for intento in range(1, intentos + 1):
                    if info is not None:
                        break
                    state["ultimo_intento"] = intento == intentos
                    try:
                        info, fp = await run_ytdlp(_run)
                        break
                    except Exception as e:
                        if _es_cancel(e):
                            raise
                        if is_bot_check_error(e):
                            # ULTIMO RECURSO: el muro de verificacion. Con
                            # cookies importadas se reintenta UNA vez con una
                            # copia plana; sin ellas, se falla con un codigo
                            # distinto para que la UI ofrezca importarlas.
                            from . import youtube_cookies
                            texto = youtube_cookies.load_text()
                            if not texto:
                                _finish(job_id, status="error", error=str(e),
                                        error_code="youtube_bot_check")
                                log.warning("ytdlp: YouTube pide verificar que no "
                                            "es un bot y no hay cookies importadas")
                                raise BotCheckError(
                                    "YouTube pidio confirmar que no sos un bot. "
                                    "Importa un cookies.txt desde la configuracion "
                                    "y reintenta.") from e
                            log.info("ytdlp: reintento unico con las cookies importadas")
                            with youtube_cookies.plaintext_tempfile(
                                    texto, TEMP_DIR) as cookiefile:
                                try:
                                    info, fp = await run_ytdlp(_run, str(cookiefile))
                                    break
                                except Exception as e2:
                                    if _es_cancel(e2):
                                        raise
                                    code = ("youtube_bot_check"
                                            if is_bot_check_error(e2) else None)
                                    _finish(job_id, status="error", error=str(e2),
                                            **({"error_code": code} if code else {}))
                                    log.warning("ytdlp: el reintento con cookies "
                                                "fallo: %s", e2)
                                    raise RuntimeError(f"yt-dlp: {e2}") from e2
                        if intento < intentos and is_transient_error(e):
                            espera = delays[intento - 1]
                            log.warning(
                                "ytdlp download: error transitorio (intento %d/%d), "
                                "reintento en %.1fs: %s", intento, intentos, espera, e)
                            _preparar_reintento()
                            await asyncio.sleep(espera)
                            continue
                        # El frontend nunca muestra este texto: solo el codigo
                        # (transitorio se puede resolver solo; permanente, no).
                        _finish(job_id, status="error", error=str(e),
                                error_code="transient" if is_transient_error(e)
                                else "permanent")
                        log.warning("ytdlp download fallo: %s", e)
                        raise RuntimeError(f"yt-dlp: {e}")

                path = Path(fp)
                if not path.exists():
                    _finish(job_id, status="error")
                    raise RuntimeError("yt-dlp: el archivo no quedó en disco")

                # tags con mutagen (el postprocessor de ffmpeg no los pone). En modo
                # "matched" la ficha canonica es la de iTunes (title/artist/album), que
                # es mas limpia que el titulo del video ("Numb (Official Music Video)
                # [4K UPGRADE] - Linkin Park"). Se usa la del video solo como fallback.
                info_title = info.get("title") or ""
                use_itunes = bool(track.extra.get("from_itunes"))
                tag_track = Track(
                    source=self.name, source_id=track.source_id,
                    title=(track.title if use_itunes and track.title else info_title),
                    artist=(track.artist if use_itunes and track.artist
                            else (info.get("uploader") or track.artist)),
                    album=track.album,
                    year=track.year,
                    duration_s=int(info.get("duration") or 0) or track.duration_s,
                    # Los campos de album viven en extra; sin esta copia el
                    # tag_track nuevo los perderia y no habria orden de disco.
                    extra=dict(track.extra or {}),
                )
                await run_storage(_write_tags, path, tag_track)
                # La extension es la del archivo real: con "both" el merge deja
                # un .mp4, pero el fallback a un unico archivo (`b`) puede ser
                # .webm, y la clave no puede mentir sobre lo que contiene.
                key = f"{key_base}{path.suffix}"
                # Del key y no de `path.name`: yt-dlp puede sanear el nombre a
                # su manera, y la UI tiene que mostrar lo que quedo guardado.
                filename = key.rsplit("/", 1)[-1]
                with _JOBS_LOCK:
                    JOBS[job_id]["phase"] = "saving"
                # Las portadas se pidieron al empezar la bajada. Si el CDN tarda
                # mas que el audio, NO se espera: el tema queda usable y la
                # portada se puede backfill despues («Buscar portadas»).
                covers = None
                if cover_task is not None and use_itunes:
                    try:
                        covers = await asyncio.wait_for(cover_task, COVER_WAIT_S)
                    except Exception:
                        covers = None
                # Audio con ficha de iTunes: su portada en dos tamanos va junto
                # al audio, en un solo `put_files`. El registro del veredicto
                # entra EN EL MISMO lote de subida, no como un PUT serial mas.
                items = [(key, path)]
                if covers:
                    items += [(thumb_sidecar_key(key), covers[0]),
                              (thumb_small_sidecar(key), covers[1])]

                referencia = identity_best_reference(
                    query, track, info_title, info_title or track.title)
                estado, etiqueta = verdict(referencia, info_title)
                size_esperado = path.stat().st_size
                record = build_download_record(
                    track, size_esperado, via="ytdlp", query=referencia,
                    video_title=info_title,
                    vacuous=bool(query and parse_youtube_url(query))
                    or (not query and not track.extra.get("from_itunes")))

                def _on_upload_bytes(done: int, total: int) -> None:
                    with _JOBS_LOCK:
                        JOBS[job_id]["phase"] = "uploading"
                        JOBS[job_id]["progress"] = (
                            round(done / total * 100, 1) if total else 100.0)
                    if on_progress is not None:
                        on_progress()

                with _JOBS_LOCK:
                    JOBS[job_id]["phase"] = "uploading"
                    JOBS[job_id]["progress"] = 0.0
                if on_progress is not None:
                    on_progress()
                try:
                    stored = (await run_storage(
                        get_storage().put_files, items, journal=True,
                        fileinfo=(key, record) if record else None,
                        on_bytes=_on_upload_bytes))[0]
                except Exception as e:
                    if not covers:
                        raise
                    # Si fallo una portada, el audio (el primero) ya quedo.
                    log.warning("ytdlp: fallaron las portadas de %s: %s", key, e)
                    try:
                        stored = await run_storage(get_storage().stat, key)
                    except Exception:
                        raise e
                    covers = None
                size = stored.size
                with _JOBS_LOCK:
                    JOBS[job_id]["phase"] = "saving"
                    JOBS[job_id]["progress"] = 100.0
                # Miniatura best effort SOLO para video: si falla, la descarga
                # sigue y `thumb_key` queda en None (nunca tumba el job).
                if kind == "video":
                    thumb_key = await fetch_thumb(info.get("id"), key, work)
                else:
                    thumb_key = thumb_sidecar_key(key) if covers else None

                # El veredicto ya se escribio DENTRO de `put_files` (mismo lote
                # de hilos que el audio), asi que `_finish` puede marcar `done`
                # sin una segunda request serial a la nube.
                # `height` es la altura PEDIDA (None si no se eligio): la UI la
                # muestra como "1080p" del archivo que acaba de bajar.
                altura = (int(height) if height is not None
                          and media in ("both", "video") else None)
                _finish(job_id, status="done", progress=100.0, key=key,
                        filename=filename, size_mb=round(size / 1_048_576, 2),
                        format=path.suffix.lstrip(".").upper(), kind=kind,
                        thumb_key=thumb_key, height=altura,
                        match=estado, match_label=etiqueta, real_title=info_title or None)
                exito = True
                return {
                    "key": key, "filename": filename, "folder": folder,
                    "bytes": size, "size_mb": round(size / 1_048_576, 2),
                    "format": path.suffix.lstrip(".").upper(), "job_id": job_id,
                    "kind": kind, "thumb_key": thumb_key, "height": altura,
                    "match": estado, "match_label": etiqueta,
                    "real_title": info_title or None,
                }
            except BaseException as e:
                if _es_cancel(e):
                    # La cancelacion no es un error de red: el job se cierra
                    # como "cancelled" y el progress hook ya aborto la bajada.
                    cancelado = True
                    _finish(job_id, status="cancelled")
                raise
            finally:
                if cover_task is not None and not cover_task.done():
                    cover_task.cancel()
                # Exito o cancelacion: la carpeta se borra (el archivo terminado
                # ya salio por put_file). En ERROR se conserva: continuedl
                # necesita el .part para no empezar de cero en el reintento.
                if exito or cancelado:
                    await run_storage(shutil.rmtree, work, ignore_errors=True)


def get_job(job_id: str) -> dict | None:
    with _JOBS_LOCK:
        return JOBS.get(job_id)
