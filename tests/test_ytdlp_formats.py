"""Resoluciones de video de YouTube: deteccion, eleccion y descarga acotada.

Todo OFFLINE. `probe_info` y `download` hacen `import yt_dlp` perezoso, asi que un
doble en `sys.modules` alcanza (mismo truco que test_ytdlp_media). El doble de
descarga NO baja miniatura (`video_id=None`): nunca se toca httpx ni la red.

Cubre:
- `summarize_formats`: la funcion PURA que traduce los formatos crudos de
  yt-dlp a la lista que consume el picker (dedupe por altura, preferencia,
  4K/8K, HDR, storyboards afuera, fallbacks de fps/filesize, orden).
- `media_opts`/`media_selector` con y sin `height`, para audio/video/both.
- la validacion de `height` en el body de `/api/download`.
- `/api/formats`: forma de la respuesta, 422 para lo que no es un video de
  YouTube, 502 (con y sin `code`) para los fallos de yt-dlp y la cache de 5 min.
- el nombre de la clave con `height` (both/video) y que `library_scan` siga
  detectando `has_audio` en `... [1080p] (sin audio).mp4`.
"""
from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path

import pytest
from starlette.exceptions import HTTPException

from backend.app import ytdlp_source as ys
from backend.app.main import DownloadReq
from backend.app.models import Track
from backend.app.ytdlp_source import media_opts, media_selector, summarize_formats

FORMATO_BOTH_1080 = media_selector("both", 1080)
FORMATO_VIDEO_1080 = media_selector("video", 1080)


@pytest.fixture(autouse=True)
def _cache_limpia():
    """La cache de resoluciones no puede filtrarse de un test al siguiente."""
    ys.clear_formats_cache()
    yield
    ys.clear_formats_cache()


def _fmt(**kw) -> dict:
    """Formato crudo de yt-dlp con defaults de video mp4/avc1 1080p30."""
    base = {"format_id": "x", "ext": "mp4", "vcodec": "avc1.640028",
            "acodec": "none", "height": 1080, "fps": 30, "filesize": 10_000_000}
    base.update(kw)
    return base


# --------------------------------------------------------- summarize_formats
def test_summarize_dedupe_por_altura_y_orden_desc():
    info = {"formats": [
        _fmt(height=720, filesize=5_000_000),
        _fmt(height=1080, filesize=9_000_000),
        _fmt(height=720, filesize=6_000_000, format_id="otro"),
    ]}
    out = summarize_formats(info)
    assert [r["height"] for r in out] == [1080, 720]
    # una sola entrada por altura, con el candidato de mayor tamano
    assert out[1]["filesize"] == 6_000_000


def test_summarize_prefiere_mp4_avc1_sobre_otro_codec():
    info = {"formats": [
        _fmt(ext="webm", vcodec="vp9", filesize=50_000_000),
        _fmt(ext="mp4", vcodec="bogus", filesize=60_000_000),
        _fmt(ext="mp4", vcodec="avc1.640028", filesize=10_000_000),
    ]}
    out = summarize_formats(info)
    assert len(out) == 1
    assert out[0]["ext"] == "mp4"
    # gano el avc1 mp4 aunque es el mas chico
    assert out[0]["filesize"] == 10_000_000


def test_summarize_prefiere_mayor_fps_y_despues_mayor_tamano():
    info = {"formats": [
        _fmt(fps=30, filesize=99_000_000, format_id="a"),
        _fmt(fps=60, filesize=10_000_000, format_id="b"),
        _fmt(fps=60, filesize=20_000_000, format_id="c"),
    ]}
    out = summarize_formats(info)
    # 60fps gana a 30fps; entre los 60fps gana el mas grande
    assert out[0]["fps"] == 60
    assert out[0]["filesize"] == 20_000_000


@pytest.mark.parametrize("height,label", [
    (144, "144p"), (360, "360p"), (1080, "1080p"), (1440, "1440p"),
    (2160, "4K"), (4320, "8K"),
])
def test_summarize_labels(height, label):
    assert summarize_formats({"formats": [_fmt(height=height)]})[0]["label"] == label


@pytest.mark.parametrize("dr,hdr", [
    ("HDR", True), ("HDR10", True), ("SDR", False), (None, False),
])
def test_summarize_hdr(dr, hdr):
    info = {"formats": [_fmt(dynamic_range=dr)]}
    assert summarize_formats(info)[0]["hdr"] is hdr


def test_summarize_sin_dynamic_range_no_es_hdr():
    assert summarize_formats({"formats": [_fmt()]})[0]["hdr"] is False


def test_summarize_descarta_solo_audio_y_sin_altura():
    info = {"formats": [
        _fmt(vcodec="none", acodec="mp4a.40.2", height=None),  # solo audio
        _fmt(height=None),                                       # sin altura
        _fmt(height="1080"),                                     # altura rara
        _fmt(height=1080),
    ]}
    out = summarize_formats(info)
    assert [r["height"] for r in out] == [1080]


def test_summarize_descarta_storyboards_y_bajas():
    info = {"formats": [
        _fmt(ext="mhtml", vcodec="none", height=90),
        _fmt(format_note="storyboard", height=1080),   # nota de storyboard
        _fmt(height=90),                                # < 144
        _fmt(height=144),
    ]}
    out = summarize_formats(info)
    assert [r["height"] for r in out] == [144]


def test_summarize_fps_redondeado_y_filesize_fallbacks():
    info = {"formats": [
        _fmt(height=1080, fps=29.97, filesize=None, filesize_approx=7_000_000),
        _fmt(height=1080, fps=None, format_id="sin-fps"),
    ]}
    out = summarize_formats(info)
    # el primer candidato tiene fps real; el segundo cae a 0 y pierde
    assert out[0]["fps"] == 30
    assert out[0]["filesize"] == 7_000_000

    solo_aprox = summarize_formats({"formats": [
        _fmt(filesize=None, filesize_approx=1234)]})
    assert solo_aprox[0]["filesize"] == 1234

    sin_nada = summarize_formats({"formats": [
        _fmt(filesize=None, filesize_approx=None)]})
    assert sin_nada[0]["filesize"] is None


def test_summarize_sin_formatos():
    assert summarize_formats({}) == []
    assert summarize_formats({"formats": None}) == []


# ------------------------------------------------------------------ media_opts
def test_media_opts_audio_con_height_es_lo_de_siempre():
    opts = media_opts("audio", "m4a", height=1080)
    assert opts["format"] == "bestaudio/best"
    assert "merge_output_format" not in opts
    assert opts["postprocessors"][0]["key"] == "FFmpegExtractAudio"


def test_media_opts_both_height_exacto():
    opts = media_opts("both", "mp3", height=1080)
    assert opts["format"] == FORMATO_BOTH_1080
    assert opts["merge_output_format"] == "mp4"
    assert opts["postprocessors"] == []


def test_media_opts_video_height_exacto():
    opts = media_opts("video", "mp3", height=1080)
    assert opts["format"] == FORMATO_VIDEO_1080
    assert "merge_output_format" not in opts
    assert opts["postprocessors"] == []


def test_media_opts_sin_height_no_cambia():
    assert media_opts("both")["format"] == media_selector("both")
    assert media_opts("video")["format"] == media_selector("video")
    assert "height" not in media_opts("both")["format"]


def test_media_selector_audio_ignora_height():
    # el selector de audio no depende de height
    assert media_selector("audio") == "bestaudio/best"


# --------------------------------------------------------------- DownloadReq
@pytest.mark.parametrize("media", ["video", "both"])
def test_height_valido_se_acepta(media):
    req = DownloadReq.from_body({"source": "ytdlp", "track": {},
                                 "media": media, "height": 1080})
    assert req.height == 1080


def test_height_ausente_o_null_es_none():
    assert DownloadReq.from_body({"source": "ytdlp", "track": {},
                                  "media": "video"}).height is None
    assert DownloadReq.from_body({"source": "ytdlp", "track": {},
                                  "media": "video", "height": None}).height is None


def test_height_se_ignora_con_audio():
    req = DownloadReq.from_body({"source": "ytdlp", "track": {},
                                 "media": "audio", "height": 1080})
    assert req.height is None


@pytest.mark.parametrize("malo", [100, 4321, 0, -1080, "1080", 1080.5, True, False,
                                  [1080], {}])
def test_height_invalido_da_422(malo):
    with pytest.raises(HTTPException) as exc:
        DownloadReq.from_body({"source": "ytdlp", "track": {},
                               "media": "video", "height": malo})
    assert exc.value.status_code == 422
    assert exc.value.detail[0]["loc"] == ["body", "height"]


def test_height_invalido_en_la_api_da_422(cliente):
    r = cliente.post("/api/download", json={
        "source": "ytdlp", "track": {"source": "x"}, "media": "video",
        "height": 9999})
    assert r.status_code == 422
    assert r.json()["detail"][0]["loc"] == ["body", "height"]


# ------------------------------------------------------------------- /api/formats
class YtDlpFormatsFalso:
    """`yt_dlp.YoutubeDL` que devuelve un `info` fijo, sin descargar nada."""

    info: object = {}
    llamadas: int = 0
    opts_vistos: list[dict] = []

    def __init__(self, opts):
        self.opts = opts
        type(self).opts_vistos.append(opts)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=False):
        type(self).llamadas += 1
        if isinstance(type(self).info, Exception):
            raise type(self).info
        return type(self).info


INFO_VIDEO = {
    "id": "dQw4w9WgXcQ",
    "title": "Un tema",
    "duration": 213,
    "formats": [
        _fmt(format_id="137", height=1080, fps=30, filesize=50_000_000,
             dynamic_range="SDR"),
        _fmt(format_id="248", ext="webm", vcodec="vp9", height=1080,
             filesize=40_000_000),
        _fmt(format_id="18", height=360, filesize=10_000_000),
        _fmt(format_id="140", vcodec="none", acodec="mp4a.40.2", height=None),
    ],
}


@pytest.fixture
def entorno_formats(monkeypatch):
    mod = types.ModuleType("yt_dlp")
    mod.YoutubeDL = YtDlpFormatsFalso
    monkeypatch.setitem(sys.modules, "yt_dlp", mod)
    YtDlpFormatsFalso.info = INFO_VIDEO
    YtDlpFormatsFalso.llamadas = 0
    YtDlpFormatsFalso.opts_vistos = []
    yield


def test_formats_respuesta_del_endpoint(cliente, entorno_formats):
    r = cliente.get("/api/formats",
                    params={"url": "https://youtu.be/dQw4w9WgXcQ"})
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "dQw4w9WgXcQ"
    assert body["title"] == "Un tema"
    assert body["duration_s"] == 213
    assert [res["height"] for res in body["resolutions"]] == [1080, 360]
    primero = body["resolutions"][0]
    assert primero == {"height": 1080, "label": "1080p", "fps": 30,
                       "ext": "mp4", "filesize": 50_000_000, "hdr": False}
    # el probe salio SIN descargar
    assert YtDlpFormatsFalso.opts_vistos[0]["skip_download"] is True


def test_formats_url_que_no_es_video_da_422(cliente, entorno_formats):
    for mala in ("https://example.com/watch?v=abc",
                 "https://www.youtube.com/playlist?list=PL123",
                 "numb linkin park",
                 "https://www.youtube.com/watch?v=corto"):
        r = cliente.get("/api/formats", params={"url": mala})
        assert r.status_code == 422, mala
        assert r.json()["detail"][0]["loc"] == ["query", "url"]
    # y no se probe nada
    assert YtDlpFormatsFalso.llamadas == 0


def test_formats_sin_url_da_422(cliente, entorno_formats):
    r = cliente.get("/api/formats")
    assert r.status_code == 422
    assert r.json()["detail"][0]["loc"] == ["query", "url"]


def test_formats_bot_check_da_502_con_codigo(cliente, entorno_formats):
    YtDlpFormatsFalso.info = RuntimeError(
        "Sign in to confirm you're not a bot")
    r = cliente.get("/api/formats",
                    params={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"})
    assert r.status_code == 502
    assert r.json()["code"] == "youtube_bot_check"


def test_formats_error_generico_da_502_sin_codigo(cliente, entorno_formats):
    YtDlpFormatsFalso.info = RuntimeError("boom")
    r = cliente.get("/api/formats",
                    params={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"})
    assert r.status_code == 502
    assert r.json()["detail"].startswith("yt-dlp:")
    assert "code" not in r.json()


def test_formats_usa_cache_y_no_reprobea(cliente, entorno_formats):
    url = {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}
    r1 = cliente.get("/api/formats", params=url)
    assert r1.status_code == 200
    llamadas = YtDlpFormatsFalso.llamadas

    r2 = cliente.get("/api/formats", params=url)
    assert r2.status_code == 200
    assert r2.json() == r1.json()
    assert YtDlpFormatsFalso.llamadas == llamadas  # la cache evito el segundo probe


# ---------------------------------------------------------- clave con height
class YtDlpMediaFalso:
    """`yt_dlp.YoutubeDL` que "descarga" un archivo con la extension pedida.

    `video_id=None`: no se pide miniatura, asi que no se toca httpx ni la red.
    """

    ext_salida = "mp4"
    opts_vistos: list[dict] = []

    def __init__(self, opts):
        self.opts = opts
        type(self).opts_vistos.append(opts)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=True):
        opts = self.opts
        rel = opts["outtmpl"].replace("%(ext)s", type(self).ext_salida)
        destino = Path((opts.get("paths") or {})["home"]) / rel
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_bytes(b"\x00" * 256)
        return {"filepath": str(destino), "id": None, "title": "Tema",
                "uploader": "Artista", "duration": 5}


@pytest.fixture
def entorno_media(monkeypatch):
    mod = types.ModuleType("yt_dlp")
    mod.YoutubeDL = YtDlpMediaFalso
    monkeypatch.setitem(sys.modules, "yt_dlp", mod)
    monkeypatch.setattr(ys, "RETRY_DELAYS_S", (0.0, 0.0))
    YtDlpMediaFalso.opts_vistos = []
    YtDlpMediaFalso.ext_salida = "mp4"
    ys._LOCKS_POR_RUTA.clear()
    yield
    ys._LOCKS_POR_RUTA.clear()


def _bajar(media: str, height: int | None = None, fmt: str = "mp3"):
    track = Track(source="ytdlp", source_id="yt-h", title="Tema",
                  artist="Artista", extra={"webpage_url": "https://youtu.be/abc"})
    job_id = ys.new_job("Tema")
    res = asyncio.run(ys.YtDlpSource().download(track, fmt, job_id=job_id,
                                                media=media, height=height))
    return res, job_id


def test_clave_both_con_height(entorno_media, tmp_path, storage_temporal):
    storage_temporal(tmp_path / "lib")
    res, job_id = _bajar("both", height=1080)

    assert res["key"] == "Artista/Artista - Tema [1080p].mp4"
    assert res["height"] == 1080
    assert res["kind"] == "video"
    assert YtDlpMediaFalso.opts_vistos[0]["format"] == FORMATO_BOTH_1080
    assert ys.get_job(job_id)["height"] == 1080


def test_clave_video_con_height_lleva_sin_audio_al_final(entorno_media, tmp_path,
                                                         storage_temporal):
    storage_temporal(tmp_path / "lib")
    YtDlpMediaFalso.ext_salida = "webm"
    res, job_id = _bajar("video", height=1080)

    assert res["key"] == "Artista/Artista - Tema [1080p] (sin audio).webm"
    assert res["height"] == 1080
    assert YtDlpMediaFalso.opts_vistos[0]["format"] == FORMATO_VIDEO_1080
    assert ys.get_job(job_id)["height"] == 1080


def test_sin_height_la_clave_no_cambia(entorno_media, tmp_path, storage_temporal):
    storage_temporal(tmp_path / "lib")
    res, job_id = _bajar("both")

    assert res["key"] == "Artista/Artista - Tema.mp4"
    assert res["height"] is None
    assert ys.get_job(job_id)["height"] is None


def test_library_scan_detecta_has_audio_con_height(tmp_path, storage_temporal):
    import backend.app.downloader as dl

    storage_temporal(tmp_path)
    (tmp_path / "A").mkdir()
    for nombre in ("A - Clip [1080p].mp4",
                   "A - Mudo [1080p] (sin audio).mp4"):
        (tmp_path / "A" / nombre).write_bytes(b"\x00" * 32)

    escaneo = {f["filename"]: f for f in dl.library_scan()}
    assert escaneo["A - Clip [1080p].mp4"]["has_audio"] is True
    assert escaneo["A - Mudo [1080p] (sin audio).mp4"]["has_audio"] is False
    assert escaneo["A - Mudo [1080p] (sin audio).mp4"]["kind"] == "video"
