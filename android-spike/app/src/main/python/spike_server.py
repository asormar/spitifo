"""SPIKE ONLY - Starlette port of backend/app/main.py's HTTP layer.

Why: pydantic-core (needed by FastAPI) has no Android wheel. This module
reproduces the routes of backend/app/main.py 1:1 on plain Starlette (no
fastapi, no pydantic), calling the same unchanged domain modules under
backend.app.*. It is throwaway; the real migration happens in roadmap
session 3. Keep route behaviour in sync with main.py by hand.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
import time

_T0 = time.perf_counter()

from contextlib import asynccontextmanager  # noqa: E402
from pathlib import Path  # noqa: E402

from starlette.applications import Starlette  # noqa: E402
from starlette.exceptions import HTTPException  # noqa: E402
from starlette.middleware import Middleware  # noqa: E402
from starlette.middleware.cors import CORSMiddleware  # noqa: E402
from starlette.requests import Request  # noqa: E402
from starlette.responses import FileResponse, JSONResponse  # noqa: E402
from starlette.routing import Mount, Route  # noqa: E402
from starlette.staticfiles import StaticFiles  # noqa: E402

from backend.app.downloader import LIBRARY, download_track, library_scan  # noqa: E402
from backend.app.models import Track  # noqa: E402
from backend.app.sources import (  # noqa: E402
    ALL_SOURCES, BY_NAME, search_all, _register_ytdlp)

log = logging.getLogger("spitifo")

# main.py: Path(__file__).parents[2] / "frontend" / "dist". On Android the
# python sources are not on a real filesystem path, so Kotlin copies the dist
# out of assets and passes SPITIFO_FRONTEND_DIST.
_default_dist = Path(__file__).resolve().parent / "frontend" / "dist"
FRONTEND_DIST = Path(os.getenv("SPITIFO_FRONTEND_DIST", _default_dist))

BG_TASKS: set = set()


# ----------------------------------------------------------------- helpers
def _422(loc: list, msg: str) -> HTTPException:
    return HTTPException(422, [{"type": "value_error", "loc": loc, "msg": msg}])


def _q_str(request: Request, name: str, *, required=False, default=None,
           min_length=None, max_length=None):
    v = request.query_params.get(name)
    if v is None:
        if required:
            raise _422(["query", name], "Field required")
        return default
    if min_length is not None and len(v) < min_length:
        raise _422(["query", name], f"String should have at least {min_length} characters")
    if max_length is not None and len(v) > max_length:
        raise _422(["query", name], f"String should have at most {max_length} characters")
    return v


def _q_int(request: Request, name: str, default: int, ge: int, le: int) -> int:
    v = request.query_params.get(name)
    if v is None:
        return default
    try:
        n = int(v)
    except ValueError:
        raise _422(["query", name], "Input should be a valid integer")
    if n < ge or n > le:
        raise _422(["query", name], f"Input should be between {ge} and {le}")
    return n


def _q_bool(request: Request, name: str, default: bool) -> bool:
    v = request.query_params.get(name)
    if v is None:
        return default
    s = v.strip().lower()
    if s in ("1", "true", "t", "yes", "y", "on"):
        return True
    if s in ("0", "false", "f", "no", "n", "off"):
        return False
    raise _422(["query", name], "Input should be a valid boolean")


async def _json_body(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        raise _422(["body"], "JSON decode error")
    if not isinstance(body, dict):
        raise _422(["body"], "Input should be a valid dictionary")
    return body


# TrackPayload fields: name -> (type, required)
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


def _validate_track_payload(data: dict, loc: list) -> dict:
    """Manual stand-in for pydantic TrackPayload(**data).model_dump()."""
    out: dict = {}
    for name, (typ, required) in _TRACK_FIELDS.items():
        if name not in data:
            if required:
                raise _422(loc + [name], "Field required")
            out[name] = {} if name == "extra" else None
            continue
        v = data[name]
        if v is None and not required:
            out[name] = {} if name == "extra" else None
            continue
        if typ is str:
            ok = isinstance(v, str)
        elif typ is int:
            ok = (isinstance(v, int) and not isinstance(v, bool)) or (
                isinstance(v, float) and v.is_integer())
            v = int(v) if ok else v
        elif typ is float:
            ok = isinstance(v, (int, float)) and not isinstance(v, bool)
            v = float(v) if ok else v
        else:
            ok = isinstance(v, dict)
        if not ok:
            raise _422(loc + [name], f"Input should be a valid {typ.__name__}")
        out[name] = v
    return out


def _to_track(d: dict) -> Track:
    """Port of TrackPayload.to_track()."""
    d = dict(d)
    extra = dict(d.get("extra") or {})
    for k in ("real_title", "real_artist", "match", "match_label",
              "item_url", "filename", "format", "size_mb"):
        if k in d and k not in extra and d[k] is not None:
            extra[k] = d[k]
    d["extra"] = extra
    for k in ("real_title", "real_artist", "match", "match_label",
              "item_url", "filename", "format", "size_mb"):
        d.pop(k, None)
    return Track(**d)


# ------------------------------------------------------------------ lifespan
@asynccontextmanager
async def lifespan(app):
    _register_ytdlp()
    log.info("biblioteca: %s", LIBRARY)
    log.info("fuentes activas: %s",
             [s.name for s in ALL_SOURCES if s.available()])
    yield
    for s in ALL_SOURCES:
        await s.aclose()


# -------------------------------------------------------------------- routes
async def health(request: Request):
    _register_ytdlp()
    return JSONResponse({
        "ok": True,
        "sources": [
            {"name": s.name, "active": s.available(), "needs_key": s.needs_key}
            for s in ALL_SOURCES
        ],
        "library": str(LIBRARY),
    })


async def search(request: Request):
    q = _q_str(request, "q", required=True, min_length=1, max_length=200)
    limit = _q_int(request, "limit", 20, 1, 50)
    source = _q_str(request, "source", default=None)
    mode = _q_str(request, "mode", default="matched")

    if mode == "matched" and not source:
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


async def _search_matched(q: str, limit: int) -> dict:
    import yt_dlp  # noqa: F401  (main.py imports it here too)
    from backend.app.matcher import enrich_with_ytdlp
    from backend.app.sources import ITunesSource
    _register_ytdlp()
    ysrc = BY_NAME.get("ytdlp")
    yt_on = bool(ysrc and ysrc.available())

    isrc = ITunesSource()
    it_items = await isrc._raw_search(q, limit=min(limit, 30))
    if not it_items:
        return {"query": q, "mode": "matched", "count": 0, "results": [],
                "ytdlp": yt_on}

    matched = await enrich_with_ytdlp(it_items, q, ysrc) if yt_on else {}

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

    out.sort(key=lambda t: 0 if t.extra.get("has_full") else 1)
    return {
        "query": q, "mode": "matched", "ytdlp": yt_on,
        "count": len(out),
        "full": sum(1 for t in out if t.extra.get("has_full")),
        "results": [t.to_dict() for t in out],
    }


def _group_shows(tracks: list[Track]) -> list[Track]:
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
    query = _q_str(request, "query", default=None)
    data = _validate_track_payload(await _json_body(request), ["body"])
    src = BY_NAME.get(data["source"])
    if not src:
        raise HTTPException(400, f"fuente desconocida: {data['source']}")
    t = _to_track(data)
    try:
        if t.source == "ytdlp":
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
            from backend.app.identify import similarity, verdict
            from backend.app.ytdlp_source import identity_query
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
        log.exception("resolve fallo en %s", data["source"])
        raise HTTPException(502, f"no se pudo resolver: {e}")
    return JSONResponse(t.to_dict())


async def verify(request: Request):
    q = _q_str(request, "q", required=True, min_length=1, max_length=200)
    source = _q_str(request, "source", default="archive")
    source_id = _q_str(request, "source_id", required=True)
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
    job_id = request.path_params["job_id"]
    from backend.app.ytdlp_source import get_job
    job = get_job(job_id)
    if job is None:
        return JSONResponse({"status": "unknown", "job_id": job_id})
    return JSONResponse({"job_id": job_id, **job})


async def download(request: Request):
    query = _q_str(request, "query", default=None)
    wait = _q_bool(request, "wait", False)
    body = await _json_body(request)
    # DownloadReq validation
    if not isinstance(body.get("source"), str):
        raise _422(["body", "source"], "Field required" if "source" not in body
                   else "Input should be a valid string")
    if not isinstance(body.get("track"), dict):
        raise _422(["body", "track"], "Field required" if "track" not in body
                   else "Input should be a valid dictionary")
    fmt = body.get("fmt", "original")
    if not isinstance(fmt, str):
        raise _422(["body", "fmt"], "Input should be a valid string")
    source, t = body["source"], body["track"]

    src = BY_NAME.get(source)
    if not src:
        raise HTTPException(400, f"fuente desconocida: {source}")
    if not src.available():
        raise HTTPException(403, f"la fuente {source} esta desactivada")

    t.pop("downloadable", None)
    track = _to_track(_validate_track_payload(t, ["body", "track"])) if "source" in t else None
    if track is None:
        raise HTTPException(400, "payload de track invalido")

    if source == "ytdlp" or (
        source == "itunes" and track.extra.get("webpage_url")
    ):
        from backend.app.ytdlp_source import new_job
        job_id = new_job(track.title)
        if source == "itunes":
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
                result = await ysrc.download(track, fmt, job_id=job_id, query=query)
            except ValueError as e:
                raise HTTPException(422, str(e))
            except Exception as e:
                log.exception("ytdlp descarga fallo")
                raise HTTPException(502, f"yt-dlp: {e}")
            return JSONResponse({"ok": True, "source": "ytdlp", "job_id": job_id,
                                 **ident, **result})

        async def _bg():
            try:
                await ysrc.download(track, fmt, job_id=job_id, query=query)
            except Exception as e:
                log.warning("ytdlp bg fallo: %s", e)

        task = asyncio.create_task(_bg())
        BG_TASKS.add(task)
        task.add_done_callback(BG_TASKS.discard)
        return JSONResponse({"ok": True, "source": "ytdlp", "job_id": job_id, **ident})

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
        result = await download_track(track, fmt)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        log.exception("descarga fallo")
        raise HTTPException(502, f"error descargando: {e}")

    return JSONResponse({
        "ok": True,
        "source": source,
        "match": track.extra.get("match"),
        "match_label": track.extra.get("match_label"),
        "real_title": track.extra.get("real_title"),
        "real_artist": track.extra.get("real_artist"),
        "item_url": track.extra.get("item_url"),
        **result,
    })


async def setlist(request: Request):
    source_ids = _q_str(request, "source_ids", required=True)
    q = _q_str(request, "q", default="")
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
    order = {"match": 0, "partial": 1, "unknown": 2, "mismatch": 3}
    tracks.sort(key=lambda t: order.get(t.get("match") or "unknown", 2))
    return JSONResponse({"tracks": tracks})


async def library(request: Request):
    files = await asyncio.to_thread(library_scan)
    return JSONResponse({"library": str(LIBRARY), "count": len(files), "files": files})


AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav"}


async def audio(request: Request):
    path = _q_str(request, "path", required=True)
    p = Path(path).resolve()
    if not p.is_relative_to(LIBRARY.resolve()):
        raise HTTPException(404, "no encontrado")
    if p.suffix.lower() not in AUDIO_EXTS or not p.is_file():
        raise HTTPException(404, "no encontrado")
    return FileResponse(p)


async def _http_exc(request: Request, exc: HTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code,
                        headers=getattr(exc, "headers", None))


routes = [
    Route("/api/health", health),
    Route("/api/search", search),
    Route("/api/resolve", resolve, methods=["POST"]),
    Route("/api/verify", verify),
    Route("/api/download/progress/{job_id}", progress),
    Route("/api/download", download, methods=["POST"]),
    Route("/api/setlist", setlist),
    Route("/api/library", library),
    Route("/api/audio", audio),
]
if FRONTEND_DIST.is_dir():
    routes.append(Mount("/", StaticFiles(directory=FRONTEND_DIST, html=True),
                        name="frontend"))

app = Starlette(
    routes=routes, lifespan=lifespan,
    middleware=[Middleware(CORSMiddleware, allow_origins=["*"],
                           allow_methods=["*"], allow_headers=["*"])],
    exception_handlers={HTTPException: _http_exc},
)

IMPORT_SECONDS = time.perf_counter() - _T0


def verify_binaries() -> str:
    """SPIKE ONLY: prove ffmpeg/ffprobe are on PATH and actually run.

    The backend shells out to these by name; on Android the app process cannot
    exec from its own data dir, so Kotlin symlinks them to the executables in
    nativeLibraryDir and prepends that dir to PATH. Returns a multiline report
    that Kotlin logs to logcat (tag SpitifoSpike).
    """
    import shutil
    import subprocess

    lines = []
    for name in ("ffmpeg", "ffprobe"):
        path = shutil.which(name)
        lines.append(f"{name}: which={path}")
        if not path:
            continue
        try:
            r = subprocess.run([name, "-version"], capture_output=True,
                               text=True, timeout=60)
            head = ((r.stdout or "") + (r.stderr or "")).strip().splitlines()
            lines.append(f"  rc={r.returncode} {head[0] if head else '<no output>'}")
        except Exception as e:  # noqa: BLE001 - spike diagnostic
            lines.append(f"  run failed: {type(e).__name__}: {e}")
    lines.append(f"PATH={os.environ.get('PATH')}")
    lines.append(f"LD_LIBRARY_PATH={os.environ.get('LD_LIBRARY_PATH')}")
    return "\n".join(lines)


def serve(host: str = "127.0.0.1", port: int = 8000):
    """Blocking: run uvicorn in the calling (non-main) thread."""
    import uvicorn
    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log.info("SpitifoSpike backend import took %.2fs", IMPORT_SECONDS)
    cfg = uvicorn.Config(app, host=host, port=port, log_level="info",
                         http="h11", ws="none", loop="asyncio", lifespan="on",
                         log_config=None)
    uvicorn.Server(cfg).run()


if __name__ == "__main__":
    serve(port=int(os.getenv("PORT", "8000")))
