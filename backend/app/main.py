"""Spitifo API — buscar y descargar musica (fuentes libres + yt-dlp opcional).

Starlette puro, sin FastAPI ni pydantic: el backend tiene que poder correr
embebido en Android (Chaquopy) y pydantic-core no tiene build para esa
plataforma (ver docs/adr/0001-android-embedded-python.md). Las rutas, los
parametros y las respuestas son los mismos que devolvia la version FastAPI.
"""
from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import re
import threading
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import activity
from .config import AUDIO_EXTS
from .runtime import configure_runtime, ytdlp_version

# ANTES de importar el motor: fija el PATH de ffmpeg (SPITIFO_FFMPEG_DIR) y los
# MIME de audio que Android no trae, para que esten listos cuando algo llame a
# shutil.which o sirva un archivo.
configure_runtime()

from .downloader import download_track, library_scan
from .models import Track
from .security import TokenAuthMiddleware
from .sources import ALL_SOURCES, BY_NAME, search_all, _register_ytdlp
from .storage import InvalidKey, get_storage, reset_storage

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


@asynccontextmanager
async def lifespan(app: Starlette):
    _register_ytdlp()  # registrar al arrancar para que /api/download la encuentre
    log.info("biblioteca: %s", get_storage().describe())
    log.info("fuentes activas: %s",
             [s.name for s in ALL_SOURCES if s.available()])
    yield
    for s in ALL_SOURCES:
        await s.aclose()


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


@dataclass
class DownloadReq:
    source: str
    track: dict
    fmt: str = "original"  # original | mp3 | m4a

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
        return cls(source=src, track=track, fmt=fmt)


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
    })


async def search(request: Request):
    q = _query_str(request, "q", required=True, min_length=1, max_length=200)
    limit = _query_int(request, "limit", 20, 1, 50)
    source = _query_str(request, "source", default=None)
    mode = _query_str(request, "mode", default="matched")

    # ---- modo "matched": iTunes es el catalogo, yt-dlp la descarga ----
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
    """iTunes da el catalogo (metadata limpia + portada); yt-dlp, la descarga.

    Cada resultado conserva la ficha de iTunes y, si el matcher encontro un
    video que corresponde, se puede bajar entero. Si no hay match confiable, se
    muestra igual con su preview de 30s y se dice que no hay version entera.
    """
    import yt_dlp  # noqa: F401  (importa yt_dlp, igual que la version FastAPI)
    from .matcher import enrich_with_ytdlp
    from .sources import ITunesSource
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
    """Progreso de una descarga yt-dlp en curso (la UI hace polling)."""
    job_id = request.path_params["job_id"]
    from .ytdlp_source import get_job
    job = get_job(job_id)
    if job is None:
        return JSONResponse({"status": "unknown", "job_id": job_id})
    return JSONResponse({"job_id": job_id, **job})


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

    # yt-dlp: su propio pipeline. Por defecto arranca en background y devuelve
    # job_id al toque (la UI hace polling a /api/download/progress/{id}).
    # Tambien entra aca lo que viene del modo "matched" (source=itunes con
    # webpage_url de YouTube): la ficha es de iTunes pero el audio es de yt-dlp.
    if req.source == "ytdlp" or (
        req.source == "itunes" and track.extra.get("webpage_url")
    ):
        from .ytdlp_source import new_job
        job_id = new_job(track.title)  # el job lo crea main, no hay race
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

        if wait:
            try:
                with activity.busy():
                    result = await ysrc.download(track, req.fmt, job_id=job_id,
                                                 query=query)
            except ValueError as e:
                raise HTTPException(422, str(e))
            except Exception as e:
                log.exception("ytdlp descarga fallo")
                raise HTTPException(502, f"yt-dlp: {e}")
            return JSONResponse({"ok": True, "source": "ytdlp",
                                 "job_id": job_id, **ident, **result})

        async def _bg():
            try:
                await ysrc.download(track, req.fmt, job_id=job_id,
                                    query=query)
            except Exception as e:
                log.warning("ytdlp bg fallo: %s", e)
            finally:
                activity.end()

        # begin() ANTES de crear la tarea: asi no hay ventana en la que el job
        # ya exista y el contador siga en 0 (el shell podria apagar el servicio
        # entre el return y el arranque de la tarea). El end() va en el finally
        # de _bg, pase lo que pase.
        activity.begin()
        task = asyncio.create_task(_bg())
        BG_TASKS.add(task)
        task.add_done_callback(BG_TASKS.discard)
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


async def library(request: Request):
    files = await asyncio.to_thread(library_scan)
    return JSONResponse({"library": get_storage().describe(), "count": len(files),
                         "files": files})


# --------------------------------------------------------- almacenamiento activo
# La pantalla de conexion elige donde vive la biblioteca (este dispositivo o una
# nube) sin tocar variables de entorno. OneDrive todavia no se lista.
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
    """
    key = _query_str(request, "key", required=True)
    if Path(key).suffix.lower() not in AUDIO_EXTS:
        raise HTTPException(404, "no encontrado")
    storage = get_storage()
    try:
        # A un thread: en un adapter remoto stat es una llamada de red, y en
        # el local un acceso a disco que no debe frenar el event loop.
        size = (await asyncio.to_thread(storage.stat, key)).size
    except (InvalidKey, FileNotFoundError, OSError):
        raise HTTPException(404, "no encontrado")

    # El MIME sale de la extension; runtime.register_audio_mime_types ya
    # registro los tipos de audio que Android no trae.
    ctype = mimetypes.guess_type(key)[0] or "application/octet-stream"
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
        }
        # open_range a un thread: en un adapter remoto abre la descarga (y
        # falla con 503/502 si hace falta) antes de mandar los headers.
        body = await asyncio.to_thread(storage.open_range, key, start, end)
        return StreamingResponse(body, status_code=206, media_type=ctype,
                                 headers=headers)

    body = await asyncio.to_thread(storage.open_range, key)
    return StreamingResponse(
        body, media_type=ctype,
        headers={"Accept-Ranges": _UNIT, "Content-Length": str(size)})


def _prefetch_bg(fn, key: str) -> None:
    """Corre `prefetch` fuera del request: los fallos se loguean, no se tiran."""
    try:
        fn(key)
    except Exception as exc:
        log.warning("prefetch de %s fallo: %s: %s", key, type(exc).__name__, exc)


async def prefetch(request: Request):
    """Adelanta la descarga del proximo tema (auto-advance de la biblioteca).

    La UI lo dispara al empezar un tema, con la clave del SIGUIENTE. La respuesta
    no espera la descarga: arranca en un thread y vuelve ya. Un almacenamiento sin
    cache (disco local) contesta 204: no hay nada que adelantar.
    """
    body = await _json_body(request)
    key = body.get("key")
    if not isinstance(key, str) or Path(key).suffix.lower() not in AUDIO_EXTS:
        raise HTTPException(400, "clave invalida")
    storage = get_storage()
    try:
        # Igual que /api/audio: `stat` confirma que existe antes de encolar nada.
        await asyncio.to_thread(storage.stat, key)
    except (InvalidKey, FileNotFoundError, OSError):
        raise HTTPException(404, "no encontrado")
    fn = getattr(storage, "prefetch", None)
    if fn is None:
        return Response(status_code=204)
    threading.Thread(target=_prefetch_bg, args=(fn, key), daemon=True).start()
    return JSONResponse({"key": key}, status_code=202)


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
    Route("/api/resolve", resolve, methods=["POST"]),
    Route("/api/verify", verify),
    Route("/api/download/progress/{job_id}", progress),
    Route("/api/download", download, methods=["POST"]),
    Route("/api/setlist", setlist),
    Route("/api/library", library),
    Route("/api/storage", storage_info),
    Route("/api/storage/connect", storage_connect, methods=["POST"]),
    Route("/api/storage/connect/cancel", storage_connect_cancel,
          methods=["POST"]),
    Route("/api/storage/use", storage_use, methods=["POST"]),
    Route("/api/storage/disconnect", storage_disconnect, methods=["POST"]),
    Route("/api/audio", audio),
    Route("/api/prefetch", prefetch, methods=["POST"]),
]
# Sirve el frontend compilado si existe (produccion single-port)
if FRONTEND_DIST.is_dir():
    routes.append(Mount("/", StaticFiles(directory=FRONTEND_DIST, html=True),
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
