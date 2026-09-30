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
from .sources import ALL_SOURCES, BY_NAME, search_all, _register_ytdlp

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("spitifo")

FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"

# tasks asyncio en vuelo (descargas ytdlp en background), para que Python
# no las recolecte a mitad de camino
BG_TASKS: set = set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    _register_ytdlp()  # registrar al arrancar para que /api/download la encuentre
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
    def from_track(cls, t: Track) -> "TrackPayload":
        return cls(**t.to_dict())

    def to_track(self) -> Track:
        d = self.model_dump()
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
                  "item_url", "filename", "format", "size_mb", "downloadable"):
            d.pop(k, None)
        return Track(**d)


@app.get("/api/health")
async def health():
    _register_ytdlp()  # mostrar yt-dlp en health si esta habilitada
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
    mode: str = Query("matched",
                      description="matched = iTunes+yt-dlp; sources = mezcla; "
                                  "ytdlp = solo YouTube"),
):
    # ---- modo "matched": iTunes es el catalogo, yt-dlp la descarga ----
    if mode == "matched" and not source:
        return await _search_matched(q, limit)

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

    return {
        "query": q, "mode": mode, "count": len(tracks),
        "results": [t.to_dict() for t in tracks],
    }


async def _search_matched(q: str, limit: int) -> dict:
    """iTunes da el catalogo (metadata limpia + portada); yt-dlp, la descarga.

    Cada resultado conserva la ficha de iTunes y, si el matcher encontro un
    video que corresponde, se puede bajar entero. Si no hay match confiable, se
    muestra igual con su preview de 30s y se dice que no hay version entera.
    """
    import yt_dlp
    from .matcher import enrich_with_ytdlp
    from .sources import ITunesSource, _register_ytdlp
    _register_ytdlp()
    ysrc = BY_NAME.get("ytdlp")
    yt_on = bool(ysrc and ysrc.available())

    # 1) catalogo de iTunes (metadata cruda, con duracion y portada)
    isrc = ITunesSource()
    it_items = await isrc._raw_search(q, limit=min(limit, 30))
    if not it_items:
        return {"query": q, "mode": "matched", "count": 0, "results": [],
                "ytdlp": yt_on}

    # 2) una sola busqueda en YouTube y emparejar
    matched = await enrich_with_ytdlp(it_items, q, ysrc) if yt_on else {}

    # 3) armar los Tracks
    out: list[Track] = []
    for it in it_items:
        key = str(it.get("trackId") or it.get("collectionId") or
                  it.get("trackName", ""))
        m = matched.get(key) or {}
        vid = m.get("video")
        t = Track(
            source="itunes",
            source_id=key,
            title=it.get("trackName", ""),
            artist=it.get("artistName", ""),
            album=it.get("collectionName"),
            duration_s=(it.get("trackTimeMillis") or 0) // 1000 or None,
            artwork_url=(it.get("artworkUrl100") or "").replace(
                "100x100", "300x300") or None,
            preview_url=it.get("previewUrl"),
            year=(it.get("releaseDate") or "")[:4] or None,
            license="ToS de YouTube (uso personal, riesgo legal)" if vid
            else "preview de iTunes (30s)",
            extra={
                "match_score": m.get("score"),
                "match_why": m.get("why"),
                "has_full": bool(vid),
                "needs_resolve": bool(vid),
                "downloader": "ytdlp" if vid else None,
                "item_url": it.get("trackViewUrl"),
            },
        )
        if vid:
            t.extra["webpage_url"] = m["webpage_url"]
            t.extra["video_title"] = vid.get("title")
            t.extra["channel"] = vid.get("uploader")
        out.append(t)

    # con version entera primero
    out.sort(key=lambda t: 0 if t.extra.get("has_full") else 1)
    return {
        "query": q, "mode": "matched", "ytdlp": yt_on,
        "count": len(out),
        "full": sum(1 for t in out if t.extra.get("has_full")),
        "results": [t.to_dict() for t in out],
    }


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


@app.post("/api/resolve")
async def resolve(payload: TrackPayload, query: str | None = None):
    """Completa audio_url y VERIFICA la identidad real del archivo.

    query: lo que el usuario escribio. Se usa para leer los tags del audio y
    decir si lo que vas a bajar es realmente lo que buscabas.
    """
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
                    audio = [f for f in fmts if f.get("acodec") != "none"
                             and f.get("vcodec") == "none"]
                    pick = max(audio, key=lambda f: f.get("abr") or 0) if audio else info
                    return pick.get("url") or info.get("url")

            t.audio_url = await loop.run_in_executor(None, _run)
            t.license = "ToS de la plataforma (uso personal)"
            from .identify import similarity, verdict
            state, label = verdict(query or t.title, t.title)
            t.extra.update({"real_title": t.title, "match": state,
                            "match_label": label, "match_score": round(
                                similarity(query or t.title, t.title), 2)})
        else:
            t = await src.resolve(t, query=query)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        log.exception("resolve fallo en %s", payload.source)
        raise HTTPException(502, f"no se pudo resolver: {e}")
    return t.to_dict()


@app.get("/api/verify")
async def verify(q: str = Query(..., min_length=1, max_length=200),
                 source: str = Query("archive"),
                 source_id: str = Query(...)):
    """Dice que hay adentro de un resultado SIN bajarlo.

    Devuelve el titulo real leido de los tags, de donde viene (item/file/URL)
    y si coincide con lo que buscabas.
    """
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
    return t.to_dict()


@app.get("/api/download/progress/{job_id}")
async def progress(job_id: str):
    """Progreso de una descarga yt-dlp en curso (la UI hace polling)."""
    from .ytdlp_source import get_job
    job = get_job(job_id)
    if job is None:
        return {"status": "unknown", "job_id": job_id}
    return {"job_id": job_id, **job}


@app.post("/api/download")
async def download(payload: DownloadReq, query: str | None = None,
                   wait: bool = Query(False, description="yt-dlp: esperar y devolver resultado, o devolver job_id ya")):
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

    # yt-dlp: su propio pipeline. Por defecto arranca en background y devuelve
    # job_id al toque (la UI hace polling a /api/download/progress/{id}).
    # Tambien entra aca lo que viene del modo "matched" (source=itunes con
    # webpage_url de YouTube): la ficha es de iTunes pero el audio es de yt-dlp.
    if payload.source == "ytdlp" or (
        payload.source == "itunes" and track.extra.get("webpage_url")
    ):
        from .ytdlp_source import new_job
        job_id = new_job(track.title)  # el job lo crea main, no hay race
        if payload.source == "itunes":
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

        if wait:
            try:
                result = await ysrc.download(track, payload.fmt, job_id=job_id,
                                             query=query)
            except ValueError as e:
                raise HTTPException(422, str(e))
            except Exception as e:
                log.exception("ytdlp descarga fallo")
                raise HTTPException(502, f"yt-dlp: {e}")
            return {"ok": True, "source": "ytdlp", "job_id": job_id,
                    **ident, **result}

        async def _bg():
            try:
                await ysrc.download(track, payload.fmt, job_id=job_id,
                                    query=query)
            except Exception as e:
                log.warning("ytdlp bg fallo: %s", e)

        task = asyncio.create_task(_bg())
        BG_TASKS.add(task)
        task.add_done_callback(BG_TASKS.discard)
        return {"ok": True, "source": "ytdlp", "job_id": job_id, **ident}

    # si la fuente necesita resolucion, hacerlo aqui (con la query para
    # poder leer los tags y decir si es lo que el usuario buscaba)
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
        result = await download_track(track, payload.fmt)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        log.exception("descarga fallo")
        raise HTTPException(502, f"error descargando: {e}")

    # propagar la identidad verificada para que la UI pueda avisar
    return {
        "ok": True,
        "source": payload.source,
        "match": track.extra.get("match"),
        "match_label": track.extra.get("match_label"),
        "real_title": track.extra.get("real_title"),
        "real_artist": track.extra.get("real_artist"),
        "item_url": track.extra.get("item_url"),
        **result,
    }


@app.get("/api/setlist")
async def setlist(source_ids: str = Query(..., description="ids separados por coma"),
                  q: str = Query("", description="consulta original")):
    """Resuelve varios items y dice que cancion hay REALMENTE en cada uno.

    Es lo que necesita la vista de concierto: los items de etree traen el
    nombre del show como titulo, asi que hay que leer los tags de cada pista
    para saber cuales son.
    """
    src = BY_NAME.get("archive")
    ids = [i.strip() for i in source_ids.split(",") if i.strip()][:60]
    if not ids:
        return {"tracks": []}

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
    return {"tracks": tracks}


@app.get("/api/library")
async def library():
    files = await asyncio.to_thread(library_scan)
    return {"library": str(LIBRARY), "count": len(files), "files": files}


# Solo formatos de audio: el endpoint sirve para preview, no para leer
# cualquier archivo que haya quedado en un subdirectorio de la biblioteca.
AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav"}


@app.get("/api/audio")
async def audio(path: str):
    """Sirve un archivo de la biblioteca para preview en el navegador."""
    p = Path(path).resolve()
    # is_relative_to y NO startswith de string: un startswith deja pasar
    # cualquier carpeta hermana que empiece con el nombre de la biblioteca
    # (library_backup, library-temp, library2...). is_relative_to compara
    # por componentes, asi que solo entra lo que esta de verdad adentro.
    if not p.is_relative_to(LIBRARY.resolve()):
        raise HTTPException(404, "no encontrado")
    if p.suffix.lower() not in AUDIO_EXTS or not p.is_file():
        raise HTTPException(404, "no encontrado")
    return FileResponse(p)


# Sirve el frontend compilado si existe (produccion single-port)
if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
