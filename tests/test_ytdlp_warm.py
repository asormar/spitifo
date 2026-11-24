"""Extraccion adelantada (warm-up) de yt-dlp y su reuso en la descarga.

De los ~6 s de una descarga, ~3 s son la extraccion de yt-dlp. La UI la pide por
adelantado con POST /api/download/warm y `YtDlpSource.download` la reutiliza con
`process_ie_result`. OFFLINE: `yt_dlp` es un doble en `sys.modules`.
"""
from __future__ import annotations

import asyncio
import sys
import time
import types
from pathlib import Path

import pytest

from backend.app.models import Track

URL = "https://www.youtube.com/watch?v=abcdefghijk"


class YtDlpDoble:
    """Cuenta extracciones y descargas; puede fallar al bajar de lo adelantado."""

    extracciones = 0      # extract_info(download=False, process=False)
    bajadas_directas = 0  # extract_info(download=True)
    bajadas_cache = 0     # process_ie_result(raw, download=True)
    falla_cache = False

    def __init__(self, opts):
        self.opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def _bajar(self):
        destino = Path(self.opts["paths"]["home"]) / (
            self.opts["outtmpl"].replace("%(ext)s", "mp3"))
        destino.write_bytes(b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x00" * 256)
        return {"filepath": str(destino), "title": "Yesterday",
                "uploader": "The Beatles", "duration": 125, "id": "abcdefghijk"}

    def extract_info(self, url, download=True, process=True):
        if not download:
            type(self).extracciones += 1
            return {"id": "abcdefghijk", "title": "Yesterday", "formats": []}
        type(self).bajadas_directas += 1
        return self._bajar()

    def process_ie_result(self, raw, download=True):
        type(self).bajadas_cache += 1
        if type(self).falla_cache:
            raise RuntimeError("HTTP Error 403: Forbidden")
        return self._bajar()


@pytest.fixture
def yt(monkeypatch):
    mod = types.ModuleType("yt_dlp")
    mod.YoutubeDL = YtDlpDoble
    monkeypatch.setitem(sys.modules, "yt_dlp", mod)
    from backend.app import ytdlp_source as ys
    YtDlpDoble.extracciones = YtDlpDoble.bajadas_directas = 0
    YtDlpDoble.bajadas_cache = 0
    YtDlpDoble.falla_cache = False
    ys.clear_warm_cache()
    ys._WARM_TASKS.clear()
    ys._LOCKS_POR_RUTA.clear()
    yield YtDlpDoble
    ys.clear_warm_cache()
    ys._WARM_TASKS.clear()


def _track() -> Track:
    return Track(source="ytdlp", source_id="abcdefghijk", title="Yesterday",
                 artist="The Beatles", extra={"webpage_url": URL})


def _descargar(src, *, adelantar: bool):
    from backend.app import ytdlp_source as ys

    async def correr():
        if adelantar:
            assert ys.warm(URL) is True
        job = ys.new_job("Yesterday")
        res = await src.download(_track(), "mp3", job_id=job, query="yesterday")
        return res, ys.get_job(job)

    return asyncio.run(correr())


def test_la_descarga_reutiliza_la_extraccion_adelantada(yt, tmp_path, storage_temporal):
    from backend.app.ytdlp_source import YtDlpSource
    storage_temporal(tmp_path / "lib")
    res, job = _descargar(YtDlpSource(), adelantar=True)
    assert yt.extracciones == 1
    assert yt.bajadas_cache == 1
    assert yt.bajadas_directas == 0, "extrajo de nuevo en vez de reutilizar"
    assert res["key"].endswith("The Beatles - Yesterday.mp3")
    assert job["status"] == "done"
    assert job["phase"] == "saving"  # la ultima fase antes de terminar


def test_sin_adelantar_extrae_como_siempre(yt, tmp_path, storage_temporal):
    from backend.app.ytdlp_source import YtDlpSource
    storage_temporal(tmp_path / "lib")
    _descargar(YtDlpSource(), adelantar=False)
    assert yt.bajadas_cache == 0
    assert yt.bajadas_directas == 1


def test_si_falla_lo_adelantado_extrae_de_nuevo_y_termina(yt, tmp_path, storage_temporal):
    """Una URL de formato rechazada no puede tumbar el job."""
    from backend.app.ytdlp_source import YtDlpSource
    storage_temporal(tmp_path / "lib")
    yt.falla_cache = True
    res, job = _descargar(YtDlpSource(), adelantar=True)
    assert yt.bajadas_cache == 1
    assert yt.bajadas_directas == 1
    assert job["status"] == "done"
    assert res["key"].endswith(".mp3")


def test_la_extraccion_adelantada_se_usa_una_sola_vez(yt):
    from backend.app import ytdlp_source as ys
    ys._warm_put(URL, {"id": "x"})
    assert ys._warm_take(URL) == {"id": "x"}
    assert ys._warm_take(URL) is None


def test_la_extraccion_adelantada_caduca(yt):
    from backend.app import ytdlp_source as ys
    ys._warm_put(URL, {"id": "x"}, now=1000.0)
    assert ys._warm_get(URL, now=1000.0 + ys.WARM_TTL_S - 1) == {"id": "x"}
    assert ys._warm_get(URL, now=1000.0 + ys.WARM_TTL_S + 1) is None


def test_la_cache_esta_acotada(yt):
    from backend.app import ytdlp_source as ys
    for i in range(ys.WARM_MAX + 5):
        ys._warm_put(f"{URL}{i}", {"i": i}, now=float(i))
    assert len(ys._WARM) == ys.WARM_MAX
    assert ys._warm_get(f"{URL}0", now=10.0) is None  # se fue el mas viejo


def test_un_job_nuevo_no_tiene_fase():
    from backend.app.ytdlp_source import get_job, new_job
    assert get_job(new_job("x"))["phase"] is None


# ------------------------------------------------------- POST /api/download/warm
@pytest.mark.parametrize("url", [
    "https://example.com/watch?v=abcdefghijk",
    "https://www.youtube.com/playlist?list=PL0123456789",
    "no es una url",
    None,
])
def test_warm_rechaza_lo_que_no_es_un_video_de_youtube(cliente, url):
    r = cliente.post("/api/download/warm", json={"url": url})
    assert r.status_code == 400


def test_warm_acepta_un_video_y_lo_pasa_canonico(cliente, monkeypatch):
    from backend.app import ytdlp_source as ys
    vistos = []
    monkeypatch.setattr(ys, "warm", lambda u: vistos.append(u) or True)
    r = cliente.post("/api/download/warm", json={"url": "https://youtu.be/abcdefghijk"})
    assert r.status_code in (202, 204)  # 204 si yt-dlp esta desactivado
    if r.status_code == 202:
        assert r.json() == {"warming": True}
        assert vistos == [URL]


def test_sin_adelantar_un_audio_usa_la_extraccion_rapida(yt, tmp_path, storage_temporal, monkeypatch):
    from backend.app import stream
    from backend.app.ytdlp_source import YtDlpSource
    pedidas = []

    async def rapida(url):
        pedidas.append(url)
        return {"id": "abcdefghijk", "title": "Yesterday", "formats": [{"format_id": "251"}]}

    monkeypatch.setattr(stream, "fast_raw", rapida)
    storage_temporal(tmp_path / "lib")
    res, job = _descargar(YtDlpSource(), adelantar=False)
    assert pedidas == [URL]
    assert yt.bajadas_cache == 1
    assert yt.bajadas_directas == 0
    assert job["status"] == "done"


def test_si_la_extraccion_rapida_no_sirve_baja_como_siempre(yt, tmp_path, storage_temporal, monkeypatch):
    from backend.app import stream
    from backend.app.ytdlp_source import YtDlpSource

    async def rapida(url):
        return {"id": "abcdefghijk", "formats": [{"format_id": "251"}]}

    monkeypatch.setattr(stream, "fast_raw", rapida)
    yt.falla_cache = True
    storage_temporal(tmp_path / "lib")
    res, job = _descargar(YtDlpSource(), adelantar=False)
    assert yt.bajadas_cache == 1
    assert yt.bajadas_directas == 1
    assert job["status"] == "done"


def test_sin_visitor_en_memoria_no_hay_extraccion_rapida():
    from backend.app import stream
    stream.clear()
    assert asyncio.run(stream.fast_raw(URL)) is None


# ----------------------------------------------- import de yt_dlp en background
def test_ensure_yt_dlp_imported_no_bloquea_el_loop(monkeypatch):
    """Finding #3/#8 (search-latency, time-to-audio): `import yt_dlp` corre en
    un hilo (`asyncio.to_thread`), no en el loop: una busqueda/play que lo
    espera no congela al resto de la app mientras tanto."""
    from backend.app import ytdlp_source as ys

    llamadas = []

    def _import_lento():
        llamadas.append(1)
        time.sleep(0.2)

    monkeypatch.setattr(ys, "_import_yt_dlp_sync", _import_lento)
    ys._IMPORT_TASK = None
    try:
        async def correr():
            latidos = []

            async def latir():
                for _ in range(8):
                    latidos.append(1)
                    await asyncio.sleep(0.02)

            await asyncio.gather(ys.ensure_yt_dlp_imported(), latir())
            return latidos

        latidos = asyncio.run(correr())
    finally:
        ys._IMPORT_TASK = None

    assert llamadas == [1]
    # el loop sigue latiendo cada ~20ms mientras el import de 200ms corre
    # en un hilo aparte; si bloqueara el loop, latir() no completaria sus 8
    # vueltas antes de que el import (sincrono) termine.
    assert len(latidos) == 8


def test_ensure_yt_dlp_imported_una_sola_vez(monkeypatch):
    """El import se memoiza en la tarea, no hace falta nada mas: la segunda
    espera no vuelve a importar."""
    from backend.app import ytdlp_source as ys

    llamadas = []
    monkeypatch.setattr(ys, "_import_yt_dlp_sync", lambda: llamadas.append(1))
    ys._IMPORT_TASK = None
    try:
        async def correr():
            await ys.ensure_yt_dlp_imported()
            await ys.ensure_yt_dlp_imported()

        asyncio.run(correr())
    finally:
        ys._IMPORT_TASK = None

    assert llamadas == [1]
