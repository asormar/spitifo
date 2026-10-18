"""Descarga de YouTube con `media`: audio (default), video y both.

Todo OFFLINE. `download()` hace `import yt_dlp` perezoso, asi que un doble en
`sys.modules` alcanza (mismo truco que test_ytdlp_reintentos). La miniatura sale
por `httpx`, que se reemplaza por un cliente falso: nunca se toca la red.

Cubre:
- `media_opts`: la funcion pura que arma format/merge/postprocessors por media.
  "audio" tiene que ser EXACTAMENTE lo de siempre.
- la validacion de `media` en el body de `/api/download` (default, validos e
  invalidos -> 422 con el mismo formato de error que el resto).
- `download`: claves por media (`both` -> .mp4, `video` -> " (sin audio)"), el
  `kind`/`thumb_key` del resultado y del job, y que un fallo de la miniatura NO
  tumbe la descarga.
"""
from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path

import httpx
import pytest
from starlette.exceptions import HTTPException

from backend.app import ytdlp_source as ys
from backend.app.main import DownloadReq
from backend.app.models import Track
from backend.app.ytdlp_source import (
    media_opts,
    media_selector,
    postprocessor_opts,
    thumb_sidecar_key,
)

FORMATO_BOTH = media_selector("both")
FORMATO_VIDEO = media_selector("video")


# ------------------------------------------------------------- media_opts
def test_media_opts_audio_es_lo_de_siempre():
    opts = media_opts("audio", "m4a")
    assert opts["format"] == "bestaudio/best"
    assert "merge_output_format" not in opts
    assert opts["postprocessors"] == postprocessor_opts("m4a")


def test_media_opts_both_une_en_mp4_sin_extraer_audio():
    opts = media_opts("both", "mp3")
    assert opts["format"] == FORMATO_BOTH
    assert opts["merge_output_format"] == "mp4"
    assert opts["postprocessors"] == []  # NADA de FFmpegExtractAudio


def test_media_opts_video_baja_solo_el_stream_de_video():
    opts = media_opts("video", "mp3")
    assert opts["format"] == FORMATO_VIDEO
    assert "merge_output_format" not in opts
    assert opts["postprocessors"] == []


def test_media_opts_desconocido_cae_a_audio():
    assert media_opts("cualquier-cosa") == media_opts("audio")


def test_media_opts_no_muta_el_default():
    """Cada llamada devuelve un dict nuevo: uno no contamina al siguiente."""
    primero = media_opts("both")
    primero["format"] = "pisado"
    assert media_opts("audio")["format"] == "bestaudio/best"


# --------------------------------------------------------- clave de miniatura
@pytest.mark.parametrize("key,esperado", [
    ("A/A - Tema.mp4", "A/A - Tema.jpg"),
    ("A/A - Tema (sin audio).webm", "A/A - Tema (sin audio).jpg"),
    ("A/varios - x.mkv", "A/varios - x.jpg"),
])
def test_thumb_sidecar_key(key, esperado):
    assert thumb_sidecar_key(key) == esperado


# ------------------------------------------------------- validacion de media
@pytest.mark.parametrize("media", ["audio", "video", "both"])
def test_media_valido_se_acepta(media):
    req = DownloadReq.from_body({"source": "ytdlp", "track": {}, "media": media})
    assert req.media == media


def test_media_por_defecto_es_audio():
    req = DownloadReq.from_body({"source": "ytdlp", "track": {}})
    assert req.media == "audio"


@pytest.mark.parametrize("malo", ["hd", "AUDIO", "", "video-audio", 3, None, True])
def test_media_invalido_da_422(malo):
    with pytest.raises(HTTPException) as exc:
        DownloadReq.from_body({"source": "ytdlp", "track": {}, "media": malo})
    assert exc.value.status_code == 422
    detalle = exc.value.detail
    assert detalle[0]["loc"] == ["body", "media"]


def test_media_invalido_en_la_api_da_422(cliente):
    r = cliente.post("/api/download", json={
        "source": "ytdlp", "track": {"source": "x"}, "media": "hd"})
    assert r.status_code == 422
    assert r.json()["detail"][0]["loc"] == ["body", "media"]


# ------------------------------------------------------------------ dobles
class YtDlpMediaFalso:
    """`yt_dlp.YoutubeDL` que "descarga" un archivo con la extension pedida."""

    ext_salida = "mp4"
    video_id: str | None = "vid123"
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
        return {"filepath": str(destino), "id": type(self).video_id,
                "title": "Tema", "uploader": "Artista", "duration": 5}


class RespuestaFalsa:
    def __init__(self, data: bytes) -> None:
        self.content = data

    def raise_for_status(self) -> None:
        return None


class ClienteThumbFalso:
    """`httpx.AsyncClient` falso: registra la URL y devuelve bytes o falla."""

    urls: list[str] = []
    falla = False
    kwargs: dict = {}

    def __init__(self, **kwargs):
        type(self).kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url):
        type(self).urls.append(url)
        if type(self).falla:
            raise RuntimeError("sin red")
        return RespuestaFalsa(b"jpeg-bytes")


@pytest.fixture
def entorno(monkeypatch):
    """Doble de yt_dlp + httpx falso + sin esperas entre reintentos."""
    mod = types.ModuleType("yt_dlp")
    mod.YoutubeDL = YtDlpMediaFalso
    monkeypatch.setitem(sys.modules, "yt_dlp", mod)
    monkeypatch.setattr(ys, "RETRY_DELAYS_S", (0.0, 0.0))
    monkeypatch.setattr(httpx, "AsyncClient", ClienteThumbFalso)
    YtDlpMediaFalso.opts_vistos = []
    YtDlpMediaFalso.ext_salida = "mp4"
    YtDlpMediaFalso.video_id = "vid123"
    ClienteThumbFalso.urls = []
    ClienteThumbFalso.falla = False
    ys._LOCKS_POR_RUTA.clear()
    yield
    ys._LOCKS_POR_RUTA.clear()


def _bajar(media: str, fmt: str = "mp3"):
    import backend.app.downloader as dl

    track = Track(source="ytdlp", source_id="yt-m", title="Tema",
                  artist="Artista", extra={"webpage_url": "https://youtu.be/abc"})
    job_id = ys.new_job("Tema")
    res = asyncio.run(ys.YtDlpSource().download(track, fmt, job_id=job_id,
                                                media=media))
    return res, job_id, dl


def test_download_audio_sin_cambios(entorno, tmp_path, storage_temporal):
    storage_temporal(tmp_path / "lib")
    YtDlpMediaFalso.ext_salida = "mp3"
    res, job_id, dl = _bajar("audio", "mp3")

    opts = YtDlpMediaFalso.opts_vistos[0]
    assert opts["format"] == "bestaudio/best"
    assert "merge_output_format" not in opts
    assert opts["postprocessors"][0]["key"] == "FFmpegExtractAudio"

    assert res["key"].endswith(".mp3")
    assert res["kind"] == "audio"
    assert res["thumb_key"] is None
    assert ClienteThumbFalso.urls == []  # el audio no baja miniatura
    assert ys.get_job(job_id)["kind"] == "audio"
    assert ys.get_job(job_id)["thumb_key"] is None


def test_download_both_deja_mp4_con_miniatura(entorno, tmp_path, storage_temporal):
    st = storage_temporal(tmp_path / "lib")
    res, job_id, dl = _bajar("both")

    opts = YtDlpMediaFalso.opts_vistos[0]
    assert opts["format"] == FORMATO_BOTH
    assert opts["merge_output_format"] == "mp4"
    assert opts["postprocessors"] == []

    assert res["key"] == "Artista/Artista - Tema.mp4"
    assert res["kind"] == "video"
    assert res["thumb_key"] == "Artista/Artista - Tema.jpg"
    # la miniatura esta de verdad en la biblioteca
    assert st.stat(res["thumb_key"]).size > 0
    # y se pidio la URL hqdefault del video
    assert ClienteThumbFalso.urls == [
        "https://i.ytimg.com/vi/vid123/hqdefault.jpg"]

    job = ys.get_job(job_id)
    assert job["status"] == "done"
    assert job["kind"] == "video"
    assert job["thumb_key"] == res["thumb_key"]

    # el scan de la biblioteca ve el video y su sidecar
    escaneo = {f["key"]: f for f in dl.library_scan()}
    assert escaneo[res["key"]]["kind"] == "video"
    assert escaneo[res["key"]]["thumb_key"] == res["thumb_key"]
    assert escaneo[res["key"]]["has_audio"] is True
    assert res["thumb_key"] not in escaneo  # el jpg no se lista como tema


def test_download_video_marca_sin_audio(entorno, tmp_path, storage_temporal):
    st = storage_temporal(tmp_path / "lib")
    YtDlpMediaFalso.ext_salida = "webm"
    res, job_id, dl = _bajar("video")

    opts = YtDlpMediaFalso.opts_vistos[0]
    assert opts["format"] == FORMATO_VIDEO
    assert "merge_output_format" not in opts
    assert opts["postprocessors"] == []

    assert res["key"] == "Artista/Artista - Tema (sin audio).webm"
    assert res["kind"] == "video"
    assert res["thumb_key"] == "Artista/Artista - Tema (sin audio).jpg"
    assert st.stat(res["thumb_key"]).size > 0

    escaneo = {f["key"]: f for f in dl.library_scan()}
    assert escaneo[res["key"]]["has_audio"] is False


def test_la_miniatura_que_falla_no_tumba_la_descarga(entorno, tmp_path,
                                                     storage_temporal):
    st = storage_temporal(tmp_path / "lib")
    ClienteThumbFalso.falla = True
    res, job_id, _ = _bajar("both")

    assert ClienteThumbFalso.urls  # se intento
    assert res["thumb_key"] is None
    assert ys.get_job(job_id)["status"] == "done"
    assert st.stat(res["key"]).size > 0


def test_download_sin_id_de_video_no_baja_miniatura(entorno, tmp_path,
                                                    storage_temporal):
    storage_temporal(tmp_path / "lib")
    YtDlpMediaFalso.video_id = None
    res, _, _ = _bajar("both")
    assert res["thumb_key"] is None
    assert ClienteThumbFalso.urls == []
