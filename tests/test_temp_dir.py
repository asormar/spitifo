"""Temporales de descarga: cada job trabaja en su PROPIA subcarpeta.

Antes todo el staging dependia de una rama opcional `TEMP_DIR is None`. Ahora no
hay rama: `TEMP_DIR` = `SPITIFO_TEMP_DIR` o `<tmp del sistema>/spitifo`, cada
descarga arma su trabajo (bajada, conversion y tags) en una subcarpeta fresca
(`tempfile.mkdtemp`) y la borra entera en el `finally`. La biblioteca solo recibe
el archivo terminado, a traves del puerto `Storage`.

Todo OFFLINE:
- `download_track` se prueba con `_download_to` monkeypatcheado.
- `yt-dlp` se prueba con un `yt_dlp.YoutubeDL` doble en `sys.modules` (mismo
  truco que test_ytdlp_reintentos): guarda los opts y crea el archivo final.
"""
from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path

import pytest

from backend.app.models import Track


# -------------------------------------------------------------- download_track
def _descarga_falsa(monkeypatch, contenido: bytes):
    """Reemplaza la bajada por red: escribe `contenido` en el tmp indicado."""
    import backend.app.downloader as dl

    async def falso(url, dest, progress=None):
        dest.write_bytes(contenido)
        return dest

    monkeypatch.setattr(dl, "_download_to", falso)
    return dl


def _track(audio_url: str, title: str = "Tono") -> Track:
    return Track(source="archive", source_id="1", title=title, artist="Prueba",
                 audio_url=audio_url)


def test_publica_el_final_y_vacia_el_temp(tmp_path, monkeypatch, storage_temporal):
    """fmt=original (.ogg): el final queda en la biblioteca y el temp queda vacio."""
    contenido = b"OggS" + b"\x00" * 128
    dl = _descarga_falsa(monkeypatch, contenido)
    lib = tmp_path / "lib"
    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setattr(dl, "TEMP_DIR", temp)
    storage_temporal(lib)

    res = asyncio.run(dl.download_track(_track("https://example.org/tono.ogg"),
                                        "original"))

    assert res["key"] == "Prueba/Prueba - Tono.ogg"
    assert res["folder"] == "Prueba"
    assert res["filename"] == "Prueba - Tono.ogg"
    final = lib / res["key"]
    assert final.exists()
    assert final.read_bytes() == contenido
    # la subcarpeta de trabajo se borro entera y en la biblioteca solo quedo el final
    assert list(temp.iterdir()) == []
    assert [p.name for p in (lib / "Prueba").iterdir()] == [final.name]


def test_convierte_en_el_temp_y_despues_publica(tmp_path, monkeypatch,
                                                wav_sintetico, storage_temporal):
    """Con conversion: el .wav y el .mp3 se arman en el temp y recien ahi se publican."""
    dl = _descarga_falsa(monkeypatch, wav_sintetico.read_bytes())
    lib = tmp_path / "lib"
    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setattr(dl, "TEMP_DIR", temp)
    storage_temporal(lib)

    res = asyncio.run(dl.download_track(_track("https://example.org/tono.wav"),
                                        "mp3"))

    assert res["key"] == "Prueba/Prueba - Tono.mp3"
    final = lib / res["key"]
    assert final.exists() and final.stat().st_size > 0
    assert list(temp.iterdir()) == []
    assert [p.name for p in (lib / "Prueba").iterdir()] == [final.name]


def test_sobreescribe_el_final(tmp_path, monkeypatch, storage_temporal):
    """Publicar de nuevo la misma clave sobreescribe el final (no duplica)."""
    import backend.app.downloader as dl

    lib = tmp_path / "lib"
    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setattr(dl, "TEMP_DIR", temp)
    storage_temporal(lib)
    payload = bytearray(b"OggS" + b"\x00" * 8)

    async def falso(url, dest, progress=None):
        dest.write_bytes(bytes(payload))

    monkeypatch.setattr(dl, "_download_to", falso)

    primera = asyncio.run(dl.download_track(
        _track("https://example.org/tono.ogg"), "original"))
    payload[:] = b"OggS" + b"\x01" * 8
    segunda = asyncio.run(dl.download_track(
        _track("https://example.org/tono.ogg"), "original"))

    assert primera["key"] == segunda["key"]
    final = lib / segunda["key"]
    assert final.read_bytes() == b"OggS" + b"\x01" * 8
    assert [p.name for p in (lib / "Prueba").iterdir()] == [final.name]


# ------------------------------------------------------------ opciones yt-dlp
class YtDlpOptsFalso:
    """Doble de `yt_dlp.YoutubeDL` que registra opts y crea <home>/<stem>.mp3.

    El outtmpl es RELATIVO y el destino lo fija `paths.home` (que ahora es la
    subcarpeta de trabajo del job, no la biblioteca).
    """

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
        home = (opts.get("paths") or {}).get("home", "")
        destino = Path(home) / rel if home else Path(rel)
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_bytes(b"\x00" * 64)
        return {"filepath": str(destino), "title": "Tema",
                "uploader": "Artista", "duration": 3}


@pytest.fixture
def yt_dlp_opts(monkeypatch):
    from backend.app import ytdlp_source as ys

    mod = types.ModuleType("yt_dlp")
    mod.YoutubeDL = YtDlpOptsFalso
    monkeypatch.setitem(sys.modules, "yt_dlp", mod)
    YtDlpOptsFalso.opts_vistos = []
    ys._LOCKS_POR_RUTA.clear()
    yield YtDlpOptsFalso
    ys._LOCKS_POR_RUTA.clear()


def _bajar(titulo: str) -> dict:
    from backend.app.ytdlp_source import YtDlpSource, new_job

    track = Track(source="ytdlp", source_id="yt-1", title=titulo,
                  artist="Artista", album="Album", year="2020",
                  extra={"webpage_url": "https://youtu.be/abc"})
    job_id = new_job(titulo)
    return asyncio.run(YtDlpSource().download(track, "mp3", job_id=job_id))


def test_outtmpl_relativo_y_paths_a_la_subcarpeta_de_trabajo(yt_dlp_opts, tmp_path,
                                                             monkeypatch,
                                                             storage_temporal):
    import backend.app.downloader as dl

    lib = tmp_path / "lib"
    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setattr(dl, "TEMP_DIR", temp)
    storage_temporal(lib)

    res = _bajar("ConTemp")

    opts = yt_dlp_opts.opts_vistos[0]
    # relativo a proposito: yt-dlp ignora `paths` con un outtmpl absoluto
    assert not Path(opts["outtmpl"]).is_absolute()
    assert "%(ext)s" in opts["outtmpl"]
    # home y temp apuntan a la MISMA subcarpeta fresca dentro del temp
    assert opts["paths"]["home"] == opts["paths"]["temp"]
    job_dir = Path(opts["paths"]["home"])
    assert job_dir.parent == temp
    # el archivo terminado quedo en la biblioteca, no en la subcarpeta
    assert res["key"] == "Artista/Artista - ConTemp.mp3"
    assert res["folder"] == "Artista"
    assert (lib / res["key"]).exists()
    assert not job_dir.exists(), "la subcarpeta de trabajo se borra al terminar"
