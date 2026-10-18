"""Parametros de yt-dlp para YouTube: runtime de JS, clientes y temp escribible.

Todo OFFLINE. Cubre lo que hace resiliente la bajada SIN cuenta:

- `js_runtimes` solo aparece cuando `SPITIFO_QJS` apunta a un archivo que
  existe; sin el, yt-dlp queda con su default.
- `extractor_args` trae los clientes de respaldo (`default`, `android_vr`,
  `web_embedded`) y se FUSIONA sobre lo que ya hubiera.
- `/api/health` informa `js_runtime`.
- `setup_temp_dir` deja `tempfile` en la particion privada y nunca lo apunta a
  algo sin permiso de escritura.
"""
from __future__ import annotations

import sys
import tempfile
import types
from pathlib import Path

import pytest

from backend.app.models import Track
from backend.app.ytdlp_source import (
    configured_js_runtime,
    extractor_args_opt,
    js_runtimes_opt,
    youtube_opts,
)

PLAYER_CLIENTS = ["default", "android_vr", "web_embedded"]


# ------------------------------------------------------------- runtime de JS
def test_js_runtimes_solo_si_el_archivo_existe(tmp_path, monkeypatch):
    monkeypatch.delenv("SPITIFO_QJS", raising=False)
    assert js_runtimes_opt() == {}
    assert "js_runtimes" not in youtube_opts()

    monkeypatch.setenv("SPITIFO_QJS", str(tmp_path / "no-existe-qjs"))
    assert js_runtimes_opt() == {}
    assert "js_runtimes" not in youtube_opts()

    qjs = tmp_path / "qjs.exe"
    qjs.write_bytes(b"binario falso")
    monkeypatch.setenv("SPITIFO_QJS", str(qjs))
    assert js_runtimes_opt() == {"quickjs": {"path": str(qjs.resolve())}}
    assert youtube_opts()["js_runtimes"] == {"quickjs": {"path": str(qjs.resolve())}}
    assert configured_js_runtime() == "quickjs"


def test_configured_js_runtime_none_sin_variable(monkeypatch):
    monkeypatch.delenv("SPITIFO_QJS", raising=False)
    assert configured_js_runtime() is None


# --------------------------------------------------------------- clientes
def test_player_client_incluye_los_defaults(monkeypatch):
    monkeypatch.delenv("SPITIFO_QJS", raising=False)
    opts = youtube_opts()
    assert (opts["extractor_args"]["youtube"]["player_client"]
            == PLAYER_CLIENTS)


def test_extractor_args_se_fusiona_no_se_reemplaza():
    args = extractor_args_opt(
        {"youtube": {"player_client": ["web_safari"], "extra": 1}})
    # lo que ya estaba se conserva (y va primero); los defaults se completan
    assert args["youtube"]["player_client"][0] == "web_safari"
    assert set(args["youtube"]["player_client"]) == set(PLAYER_CLIENTS) | {"web_safari"}
    assert args["youtube"]["extra"] == 1


def test_youtube_opts_no_pisa_otras_claves(monkeypatch):
    monkeypatch.delenv("SPITIFO_QJS", raising=False)
    base = {"quiet": True, "extractor_args": {"youtube": {"skip": ["hls"]}}}
    opts = youtube_opts(base)
    assert opts["quiet"] is True
    assert opts["extractor_args"]["youtube"]["skip"] == ["hls"]
    assert opts["extractor_args"]["youtube"]["player_client"] == PLAYER_CLIENTS


# ------------------------------------------------------- barrido del download
class YtDlpOptsFalso:
    """Doble de `YoutubeDL`: registra opts y crea <home>/<stem>.mp3."""

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
        rel = opts["outtmpl"].replace("%(ext)s", "mp3")
        destino = Path((opts.get("paths") or {})["home"]) / rel
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_bytes(b"\x00" * 128)
        return {"filepath": str(destino), "title": "Tema",
                "uploader": "Artista", "duration": 3}


@pytest.fixture
def yt_dlp_opts_falso(monkeypatch):
    from backend.app import ytdlp_source as ys

    mod = types.ModuleType("yt_dlp")
    mod.YoutubeDL = YtDlpOptsFalso
    monkeypatch.setitem(sys.modules, "yt_dlp", mod)
    monkeypatch.setattr(ys, "RETRY_DELAYS_S", (0.0, 0.0))
    monkeypatch.delenv("SPITIFO_QJS", raising=False)
    YtDlpOptsFalso.opts_vistos = []
    ys._LOCKS_POR_RUTA.clear()
    yield YtDlpOptsFalso
    ys._LOCKS_POR_RUTA.clear()


def _bajar(titulo: str = "Params") -> dict:
    import asyncio

    from backend.app.ytdlp_source import YtDlpSource, new_job

    track = Track(source="ytdlp", source_id="yt-p", title=titulo, artist="Artista",
                  extra={"webpage_url": "https://youtu.be/abc"})
    return asyncio.run(YtDlpSource().download(track, "mp3", job_id=new_job(titulo)))


def test_el_download_lleva_extractor_args(yt_dlp_opts_falso, tmp_path,
                                          storage_temporal):
    storage_temporal(tmp_path / "lib")
    _bajar()
    opts = yt_dlp_opts_falso.opts_vistos[0]
    assert opts["extractor_args"]["youtube"]["player_client"] == PLAYER_CLIENTS
    assert "js_runtimes" not in opts


def test_el_download_lleva_js_runtimes_si_hay_qjs(yt_dlp_opts_falso, tmp_path,
                                                  monkeypatch, storage_temporal):
    qjs = tmp_path / "qjs.exe"
    qjs.write_bytes(b"binario falso")
    monkeypatch.setenv("SPITIFO_QJS", str(qjs))
    storage_temporal(tmp_path / "lib")
    _bajar()
    opts = yt_dlp_opts_falso.opts_vistos[0]
    assert opts["js_runtimes"] == {"quickjs": {"path": str(qjs.resolve())}}
    assert opts["extractor_args"]["youtube"]["player_client"] == PLAYER_CLIENTS


# ------------------------------------------------------------------- health
def test_health_informa_js_runtime(cliente, tmp_path, monkeypatch):
    monkeypatch.delenv("SPITIFO_QJS", raising=False)
    assert cliente.get("/api/health").json()["js_runtime"] is None

    qjs = tmp_path / "qjs.exe"
    qjs.write_bytes(b"binario falso")
    monkeypatch.setenv("SPITIFO_QJS", str(qjs))
    assert cliente.get("/api/health").json()["js_runtime"] == "quickjs"


# ---------------------------------------------------------------- temp dir
def test_setup_temp_dir_usa_la_carpeta_privada(tmp_path, monkeypatch):
    from backend.app import runtime

    monkeypatch.setattr(tempfile, "tempdir", None)
    monkeypatch.setenv("SPITIFO_TEMP_DIR", str(tmp_path / "priv"))
    assert runtime.setup_temp_dir() is True
    assert tempfile.gettempdir() == str(tmp_path / "priv")
    creado = tempfile.mkdtemp()
    assert creado.startswith(str(tmp_path / "priv"))


def test_setup_temp_dir_sin_variable_no_toca_nada(monkeypatch):
    from backend.app import runtime

    monkeypatch.delenv("SPITIFO_TEMP_DIR", raising=False)
    monkeypatch.setattr(tempfile, "tempdir", "MARCA")
    assert runtime.setup_temp_dir() is False
    assert tempfile.tempdir == "MARCA"


def test_setup_temp_dir_ignora_una_carpeta_no_escribible(tmp_path, monkeypatch):
    from backend.app import runtime

    # Un ARCHIVO donde se espera una carpeta: mkdir() tiene que fallar y no
    # dejar `tempfile` apuntando a algo inservible.
    bloqueada = tmp_path / "archivo"
    bloqueada.write_text("no soy una carpeta", encoding="utf-8")
    monkeypatch.setattr(tempfile, "tempdir", "MARCA")
    monkeypatch.setenv("SPITIFO_TEMP_DIR", str(bloqueada))
    assert runtime.setup_temp_dir() is False
    assert tempfile.tempdir == "MARCA"
