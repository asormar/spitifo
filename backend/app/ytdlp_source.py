"""yt-dlp: buscar y descargar audio de YouTube.

Fuente EXTRA, apagada por defecto (YTDLP_ENABLED=1). Verificado en vivo: en esta
maquina (sep 2026) YouTube responde bien, da 5 formatos de solo-audio y el
progress hook anda.

Notas reales de la implementacion:
- la busqueda usa `extract_flat` (no baja metadata de cada video, es rapido)
- la descarga corre en un thread porque yt-dlp es sincrono y bloquearia FastAPI
- el progreso se reporta por una cola; la UI lo consume por polling
- el postprocessor de ffmpeg deja mp3 con tags
"""
from __future__ import annotations

import asyncio
import glob
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

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
        opts = {
            "quiet": True, "no_warnings": True, "skip_download": True,
            "extract_flat": "in_playlist", "socket_timeout": 30, "retries": 1,
        }
        loop = asyncio.get_running_loop()

        def _run():
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(f"ytsearch{limit}:{q}", download=False)

        try:
            data = await loop.run_in_executor(None, _run)
        except Exception as e:
            log.warning("ytdlp search fallo: %s", e)
            raise RuntimeError(f"yt-dlp: {e}")

        out = []
        for e in (data or {}).get("entries", []) or []:
            if not e:
                continue
            title = e.get("title") or ""
            uploader = e.get("uploader") or e.get("channel") or ""
            if not looks_like_music(title, uploader):
                continue
            out.append(Track(
                source=self.name,
                source_id=e["id"],
                title=title,
                artist=uploader,
                duration_s=e.get("duration"),
                artwork_url=None,
                extra={
                    "webpage_url": e.get("webpage_url")
                    or f"https://www.youtube.com/watch?v={e['id']}",
                    "relevance": round(relevance(q, title, uploader), 2),
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
            state, label = verdict(query or track.title, real_title)
            track.extra["real_title"] = real_title
            track.extra["real_artist"] = info.get("uploader")
            track.extra["match"] = state
            track.extra["match_label"] = label
            track.extra["duration_s"] = info.get("duration")
        return track

    # -------------------------------------------------------------- download
    async def download(self, track: Track, fmt: str = "mp3",
                       job_id: str | None = None) -> dict:
        """Descarga via yt-dlp (usa su postprocessor de ffmpeg) con progreso.

        No reutiliza downloader.download_track porque yt-dlp gestiona su propio
        pipeline de formatos + postprocess. `job_id` lo puede crear el caller
        (main.py) para que la UI sepa que id hacer polling desde el arranque.
        """
        import yt_dlp
        # import perezoso: downloader importa sources, que importa ytdlp_source
        from .downloader import LIBRARY, _write_tags
        url = track.extra.get("webpage_url")
        if not url:
            raise ValueError("ytdlp: falta webpage_url")

        if job_id is None:
            job_id = new_job(track.title)

        folder = LIBRARY / safe_name(track.artist or "varios", 60)
        folder.mkdir(parents=True, exist_ok=True)
        stem = safe_name(f"{track.artist} - {track.title}", 100)
        outtmpl = str(folder / f"{stem}.%(ext)s")

        state = {"total": None, "downloaded": 0}

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
            if estado == "error":
                # FUERA del with de arriba: _finish toma el lock y Lock no es
                # reentrante, asi que llamarlo adentro cuelga el hook.
                _finish(job_id, status="error")

        opts = {
            "quiet": True, "no_warnings": True, "noprogress": True,
            "format": "bestaudio/best",
            "outtmpl": outtmpl,
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": fmt if fmt in ("mp3", "m4a") else "mp3",
                "preferredquality": "2",
            }],
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
                    # El fallback tiene que respetar el `fmt` pedido: con el
                    # orden fijo (mp3 primero) un .mp3 ya presente en la carpeta
                    # ganaba siempre, y pedir m4a producia el .m4a pero
                    # reportaba nombre/formato/tamano del .mp3 viejo.
                    # "original" no es un codec: cae a mp3 igual que
                    # preferredcodec de arriba, asi que tampoco se busca otro.
                    want = "." + (fmt if fmt in ("mp3", "m4a") else "mp3")
                    other = ".m4a" if want == ".mp3" else ".mp3"
                    # preferir el archivo final sobre intermediarios
                    found = sorted(
                        folder.glob(glob.escape(stem) + ".*"),
                        key=lambda p: {want: 0, other: 1}.get(
                            p.suffix.lower(), 9))
                    for cand in found:
                        fp = str(cand)
                        break
                return info, fp

        with _JOBS_LOCK:
            JOBS[job_id]["status"] = "downloading"

        try:
            info, fp = await loop.run_in_executor(None, _run)
        except Exception as e:
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
        _finish(job_id, status="done", progress=100.0, path=str(path),
                filename=path.name, size_mb=round(size / 1_048_576, 2),
                format=path.suffix.lstrip(".").upper())
        return {
            "path": str(path), "filename": path.name, "folder": str(folder),
            "bytes": size, "size_mb": round(size / 1_048_576, 2),
            "format": path.suffix.lstrip(".").upper(), "job_id": job_id,
        }


def get_job(job_id: str) -> dict | None:
    with _JOBS_LOCK:
        return JOBS.get(job_id)
