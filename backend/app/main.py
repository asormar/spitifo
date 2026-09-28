"""Spitifo API — buscar y descargar musica (fuentes libres + yt-dlp opcional)."""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .downloader import LIBRARY, download_track, library_scan
from .models import Track
from .sources import ALL_SOURCES, BY_NAME, search_all

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("spitifo")

FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"

# estado en memoria de descargas en curso
JOBS: dict[str, dict] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("biblioteca: %s", LIBRARY)
    log.info("fuentes activas: %s",
             [s.name for s in ALL_SOURCES if s.available()])
    yield
    for s in ALL_SOURCES:
        await s.aclose()


app = FastAPI(title="Spitifo", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"])


class DownloadReq(BaseModel):
    source: str
    track: dict
    fmt: str = "original"  # original | mp3 | m4a


class TrackPayload(BaseModel):
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
    extra: dict = {}

    @classmethod
    def from_track(cls, t: Track) -> "TrackPayload":
        return cls(**t.to_dict())

    def to_track(self) -> Track:
        d = self.model_dump()
        return Track(**d)


@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "sources": [
            {"name": s.name, "active": s.available(),
             "needs_key": s.needs_key}
            for s in ALL_SOURCES
        ],
        "library": str(LIBRARY),
    }


@app.get("/api/search")
async def search(
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(20, ge=1, le=50),
    source: str | None = Query(None, description="filtra por una fuente"),
):
    sources = [source] if source else None
    if source and source not in BY_NAME:
        raise HTTPException(400, f"fuente desconocida: {source}")
    try:
        tracks = await search_all(q, limit, sources)
    except Exception as e:
        log.exception("search fallo")
        raise HTTPException(502, f"error buscando: {e}")

    # marca cuales se pueden descargar sin resolver
    for t in tracks:
        t.extra["needs_resolve"] = (
            t.source in ("archive", "ytdlp") and not t.audio_url)

    return {
        "query": q,
        "count": len(tracks),
        "results": [t.to_dict() for t in tracks],
    }


@app.post("/api/resolve")
async def resolve(payload: TrackPayload):
    """Completa audio_url en fuentes que lo dejan pendiente (archive, ytdlp)."""
    src = BY_NAME.get(payload.source)
    if not src:
        raise HTTPException(400, f"fuente desconocida: {payload.source}")
    t = payload.to_track()
    try:
        if t.source == "ytdlp":
            # resolver via yt-dlp al endpoint de audio
            import yt_dlp
            url = t.extra.get("webpage_url")
            if not url:
                raise ValueError("falta webpage_url")
            opts = {"quiet": True, "skip_download": True, "no_warnings": True}
            loop = asyncio.get_running_loop()

            def _run():
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                    fmts = info.get("formats", [])
                    # mejor audio-only que el navegador pueda reproducir
                    audio = [f for f in fmts if f.get("acodec") != "none"
                             and f.get("vcodec") == "none"]
                    pick = max(audio, key=lambda f: f.get("abr") or 0) if audio else info
                    return pick.get("url") or info.get("url")

            t.audio_url = await loop.run_in_executor(None, _run)
            t.license = "ToS de la plataforma (uso personal)"
        else:
            t = await src.resolve(t)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        log.exception("resolve fallo en %s", payload.source)
        raise HTTPException(502, f"no se pudo resolver: {e}")
    return t.to_dict()


@app.get("/api/download/progress/{job_id}")
async def progress(job_id: str):
    """Endpoint de progreso (placeholder; el progreso real va en el job)."""
    return JOBS.get(job_id, {"status": "unknown"})


@app.post("/api/download")
async def download(payload: DownloadReq):
    src = BY_NAME.get(payload.source)
    if not src:
        raise HTTPException(400, f"fuente desconocida: {payload.source}")
    if not src.available():
        raise HTTPException(403, f"la fuente {payload.source} esta desactivada")

    t = payload.track  # TrackPayload -> dict
    t.pop("downloadable", None)
    track = TrackPayload(**t).to_track() if "source" in t else None
    if track is None:
        raise HTTPException(400, "payload de track invalido")

    # si la fuente necesita resolucion, hacerlo aqui
    if not track.audio_url and track.extra.get("needs_resolve"):
        track = Track(**(await resolve_payload(track)).to_dict())

    if not track.audio_url:
        raise HTTPException(422, "esta pista no es descargable (solo preview)")

    try:
        result = await download_track(track, payload.fmt)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        log.exception("descarga fallo")
        raise HTTPException(502, f"error descargando: {e}")

    return {"ok": True, "source": payload.source, **result}


async def resolve_payload(track: Track) -> Track:
    src = BY_NAME[track.source]
    return await src.resolve(track)


@app.get("/api/library")
async def library():
    files = await asyncio.to_thread(library_scan)
    return {"library": str(LIBRARY), "count": len(files), "files": files}


@app.get("/api/audio")
async def audio(path: str):
    """Sirve un archivo de la biblioteca para preview en el navegador."""
    p = Path(path).resolve()
    if not str(p).startswith(str(LIBRARY.resolve())) or not p.is_file():
        raise HTTPException(404, "no encontrado")
    return FileResponse(p)


# Sirve el frontend compilado si existe (produccion single-port)
if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
