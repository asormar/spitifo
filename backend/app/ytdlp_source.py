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
import logging
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .config import AUDIO_EXTS
from .models import Track, safe_name
from .sources import Source, looks_like_music, relevance

log = logging.getLogger("spitifo.ytdlp")

# progreso de las descargas en curso: job_id -> dict
JOBS: dict[str, dict] = {}
_JOBS_LOCK = threading.Lock()

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
_LOCKS_POR_RUTA: dict[str, asyncio.Lock] = {}
_LOCKS_LOCK = threading.Lock()


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


def _lock_de_ruta(destino: str) -> asyncio.Lock:
    """Lock de una ruta de salida. Se crea una vez y se reusa.

    El dict crece sin limite a proposito: son un par de entradas por pista
    distinta descargada en toda la sesion, y un lock liberated no molesta.
    """
    with _LOCKS_LOCK:
        lock = _LOCKS_POR_RUTA.get(destino)
        if lock is None:
            lock = asyncio.Lock()
            _LOCKS_POR_RUTA[destino] = lock
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
        JOBS[job_id] = {"status": "pending", "progress": 0.0,
                        "speed": None, "eta": None, "title": title,
                        "finished_at": None}
    return job_id


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


# ------------------------------------------------------ formato de la descarga
def postprocessor_opts(fmt: str) -> list[dict]:
    """Postprocessors de yt-dlp para el `fmt` pedido.

    mp3 y m4a recodifican. "original" usa preferredcodec "best": yt-dlp extrae
    la pista de audio a su contenedor natural SIN recodificar (opus -> .opus,
    aac -> .m4a, vorbis -> .ogg). Cualquier otro valor cae a mp3 como siempre.
    """
    if fmt == "original":
        codec = "best"
    elif fmt in ("mp3", "m4a"):
        codec = fmt
    else:
        codec = "mp3"
    return [{"key": "FFmpegExtractAudio", "preferredcodec": codec,
             "preferredquality": "2"}]


def pick_output(found: list[Path], fmt: str) -> Path | None:
    """Elige el archivo final entre los `<stem>.*` que quedaron en la carpeta.

    Es el fallback para cuando yt-dlp no devuelve `filepath`. Tiene que
    respetar el `fmt` pedido: con un orden fijo, un .mp3 viejo en la carpeta
    ganaba siempre y pedir m4a reportaba el nombre/tamano del .mp3. Con
    "original" no hay una extension esperada (depende del codec de origen):
    gana cualquier extension de audio, y entre varias, la mas reciente (el
    archivo que se acaba de escribir). Lo que no es audio (.webm intermedio,
    .part) va al final.
    """
    if fmt in ("mp3", "m4a"):
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


class YtDlpSource(Source):
    name = "ytdlp"

    def available(self) -> bool:
        return os.getenv("YTDLP_ENABLED", "0") == "1"

    # ---------------------------------------------------------------- search
    async def search_candidates(self, q: str, limit: int = 20) -> list[dict]:
        """Busca cruda en YouTube, sin filtrar por 'musical'. La usa el matcher."""
        import yt_dlp
        opts = {
            "quiet": True, "no_warnings": True, "skip_download": True,
            "extract_flat": "in_playlist", "socket_timeout": 30, "retries": 1,
        }
        loop = asyncio.get_running_loop()

        def _run():
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(f"ytsearch{limit}:{q}", download=False)

        data = await loop.run_in_executor(None, _run)
        return [e for e in (data or {}).get("entries", []) or [] if e]

    async def search(self, q: str, limit: int = 20) -> list[Track]:
        if not self.available():
            return []
        import yt_dlp
        url = parse_youtube_url(q)
        opts = {
            "quiet": True, "no_warnings": True, "skip_download": True,
            "extract_flat": "in_playlist", "socket_timeout": 30, "retries": 1,
            "noplaylist": True, "playlistend": limit,
        }
        loop = asyncio.get_running_loop()

        def _run():
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(url or f"ytsearch{limit}:{q}", download=False)

        try:
            data = await loop.run_in_executor(None, _run)
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
        opts = {"quiet": True, "no_warnings": True, "skip_download": True,
                "socket_timeout": 30, "retries": 1}
        loop = asyncio.get_running_loop()

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
            info, best = await loop.run_in_executor(None, _run)
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
            state, label = verdict(identity_query(query, real_title), real_title)
            track.extra["real_title"] = real_title
            track.extra["real_artist"] = info.get("uploader")
            track.extra["match"] = state
            track.extra["match_label"] = label
            track.extra["duration_s"] = info.get("duration")
        return track

    # -------------------------------------------------------------- download
    async def download(self, track: Track, fmt: str = "mp3",
                       job_id: str | None = None,
                       query: str | None = None) -> dict:
        """Descarga via yt-dlp (usa su postprocessor de ffmpeg) con progreso.

        No reutiliza downloader.download_track porque yt-dlp gestiona su propio
        pipeline de formatos + postprocess. `job_id` lo puede crear el caller
        (main.py) para que la UI sepa que id hacer polling desde el arranque.

        `query` es lo que el usuario escribio. Se usa DESPUES de descargar,
        contra el titulo real del video, para publicar el veredicto de
        identidad en el job: sin esto la UI recibe status=done sin `match` y
        nunca puede avisar "esto no es lo que buscabas".
        """
        import yt_dlp
        # import perezoso: downloader importa sources, que importa ytdlp_source
        from .downloader import LIBRARY, _write_tags
        from .identify import verdict
        url = track.extra.get("webpage_url")
        if not url:
            raise ValueError("ytdlp: falta webpage_url")

        if job_id is None:
            job_id = new_job(track.title)

        folder = LIBRARY / safe_name(track.artist or "varios", 60)
        folder.mkdir(parents=True, exist_ok=True)
        stem = safe_name(f"{track.artist} - {track.title}", 100)
        outtmpl = str(folder / f"{stem}.%(ext)s")

        state = {"total": None, "downloaded": 0, "ultimo_intento": False}

        def hook(d):
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
                elif estado == "finished":
                    JOBS[job_id]["status"] = "processing"
            if estado == "error" and state["ultimo_intento"]:
                # FUERA del with de arriba: _finish toma el lock y Lock no es
                # reentrante, asi que llamarlo adentro cuelga el hook.
                # Solo en el ULTIMO intento: antes de eso el job sigue
                # "downloading" y el reintento puede salvarlo.
                _finish(job_id, status="error")

        opts = {
            "quiet": True, "no_warnings": True, "noprogress": True,
            "format": "bestaudio/best",
            "outtmpl": outtmpl,
            "postprocessors": postprocessor_opts(fmt),
            "progress_hooks": [hook],
            "socket_timeout": 60, "retries": 2,
            "overwrites": True,
        }
        loop = asyncio.get_running_loop()

        def _run():
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
                # Con FFmpegExtractAudio, `info['filepath']` viene None: yt-dlp
                # lo limpia tras el postprocess. NO usar prepare_filename()
                # aqui: devuelve el nombre con la extension del stream ORIGINAL
                # (webm/opus), no la del postprocess (mp3), asi que no matchea.
                # El outtmpl ya se construyo con `stem`, asi que el archivo
                # final es folder/<stem>.<ext>. Se busca por glob para tolerar
                # cualquier sanitize extra que haya hecho yt-dlp.
                fp = info.get("filepath")
                if not fp or not Path(fp).exists():
                    # Ver `pick_output`: respeta el `fmt` pedido y, con
                    # "original", acepta la extension natural del audio
                    # (.opus, .m4a, .ogg...).
                    cand = pick_output(
                        list(folder.glob(glob.escape(stem) + ".*")), fmt)
                    if cand is not None:
                        fp = str(cand)
                return info, fp

        # Una descarga por ruta de salida (ver `_lock_de_ruta`). Si otro job ya
        # esta bajando ESTE archivo, este espera en vez de chocar: se publica
        # "pending" para que la UI no diga "Descargando, 0%" mientras espera.
        lock = _lock_de_ruta(str(folder / stem))
        if lock.locked():
            with _JOBS_LOCK:
                JOBS[job_id]["status"] = "pending"

        # El lock cubre tambien `_write_tags`: si se soltara antes, el otro job
        # podria empezar a reescribir el mp3 mientras mutagen lo tiene abierto.
        async with lock:
            with _JOBS_LOCK:
                JOBS[job_id]["status"] = "downloading"

            # Reintentos: ante un error transitorio se rehace TODO (extract +
            # download) para traer URLs de formato nuevas. El job sigue
            # "downloading" entre intentos y recien pasa a error tras el ultimo.
            delays = tuple(RETRY_DELAYS_S)
            intentos = len(delays) + 1
            for intento in range(1, intentos + 1):
                state["ultimo_intento"] = intento == intentos
                try:
                    info, fp = await loop.run_in_executor(None, _run)
                    break
                except Exception as e:
                    if intento < intentos and is_transient_error(e):
                        espera = delays[intento - 1]
                        log.warning(
                            "ytdlp download: error transitorio (intento %d/%d), "
                            "reintento en %.1fs: %s", intento, intentos, espera, e)
                        state["total"] = None
                        with _JOBS_LOCK:
                            JOBS[job_id].update(
                                status="downloading", progress=0.0, speed=None,
                                eta=None, downloaded_bytes=0)
                        await asyncio.sleep(espera)
                        continue
                    _finish(job_id, status="error", error=str(e))
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
            )
            _write_tags(path, tag_track)
            size = path.stat().st_size

        # Veredicto de identidad sobre el ARCHIVO que se acaba de bajar. Se
        # calcula aca y no antes de la descarga porque hasta ahora no se
        # publicaba en ningun lado del camino con job_id: la UI recibia
        # status=done sin `match` y no podia avisar nada. `query` es lo que el
        # usuario escribio; el titulo real del video es la otra mitad.
        estado, etiqueta = verdict(identity_query(query, info_title or track.title), info_title)
        _finish(job_id, status="done", progress=100.0, path=str(path),
                filename=path.name, size_mb=round(size / 1_048_576, 2),
                format=path.suffix.lstrip(".").upper(),
                match=estado, match_label=etiqueta, real_title=info_title or None)
        return {
            "path": str(path), "filename": path.name, "folder": str(folder),
            "bytes": size, "size_mb": round(size / 1_048_576, 2),
            "format": path.suffix.lstrip(".").upper(), "job_id": job_id,
            "match": estado, "match_label": etiqueta,
            "real_title": info_title or None,
        }


def get_job(job_id: str) -> dict | None:
    with _JOBS_LOCK:
        return JOBS.get(job_id)
