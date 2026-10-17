"""SPITIFO_TEMP_DIR: staging fuera de la biblioteca publica.

En Android la biblioteca vive en Music/Spitifo (FUSE), que rechaza los
temporales de yt-dlp (.part/.webm, MIME no-audio) y donde os.replace falla con
EXDEV al cruzar de /data a /storage. Con SPITIFO_TEMP_DIR la descarga, la
conversion y los tags pasan en una carpeta privada, y recien el archivo
terminado se mueve a la biblioteca con shutil.move.

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


def test_con_temp_dir_publica_el_final_y_vacia_el_temp(tmp_path, monkeypatch):
    """fmt=original (.ogg): el final queda en LIBRARY/<artista>/ y TEMP vacio."""
    contenido = b"OggS" + b"\x00" * 128
    dl = _descarga_falsa(monkeypatch, contenido)
    lib = tmp_path / "lib"
    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setattr(dl, "LIBRARY", lib)
    monkeypatch.setattr(dl, "TEMP_DIR", temp)

    res = asyncio.run(dl.download_track(_track("https://example.org/tono.ogg"),
                                        "original"))

    final = Path(res["path"])
    assert final == lib / "Prueba" / "Prueba - Tono.ogg"
    assert final.exists()
    assert final.read_bytes() == contenido
    # el staging quedo limpio y no hay temporales ocultos en la carpeta publica
    assert list(temp.iterdir()) == []
    assert [p.name for p in (lib / "Prueba").iterdir()] == [final.name]


def test_sin_temp_dir_usa_la_carpeta_del_artista(tmp_path, monkeypatch):
    """TEMP_DIR=None: comportamiento de siempre (temporal dentro del artista)."""
    contenido = b"OggS" + b"\x00" * 128
    dl = _descarga_falsa(monkeypatch, contenido)
    lib = tmp_path / "lib"
    monkeypatch.setattr(dl, "LIBRARY", lib)
    monkeypatch.setattr(dl, "TEMP_DIR", None)

    res = asyncio.run(dl.download_track(_track("https://example.org/tono.ogg"),
                                        "original"))

    final = Path(res["path"])
    assert final == lib / "Prueba" / "Prueba - Tono.ogg"
    assert final.exists()
    assert final.read_bytes() == contenido
    # no queda ni el temporal ni nada mas
    assert [p.name for p in (lib / "Prueba").iterdir()] == [final.name]


def test_con_temp_dir_convierte_en_el_temp_y_despues_mueve(tmp_path, monkeypatch,
                                                           wav_sintetico):
    """Con conversion: el .wav y el .mp3 se arman en TEMP y recien ahi se mueven."""
    dl = _descarga_falsa(monkeypatch, wav_sintetico.read_bytes())
    lib = tmp_path / "lib"
    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setattr(dl, "LIBRARY", lib)
    monkeypatch.setattr(dl, "TEMP_DIR", temp)

    res = asyncio.run(dl.download_track(_track("https://example.org/tono.wav"),
                                        "mp3"))

    final = Path(res["path"])
    assert final == lib / "Prueba" / "Prueba - Tono.mp3"
    assert final.exists() and final.stat().st_size > 0
    assert list(temp.iterdir()) == []
    assert [p.name for p in (lib / "Prueba").iterdir()] == [final.name]


def test_con_temp_dir_sobreescribe_el_final(tmp_path, monkeypatch):
    """shutil.move sobreescribe el final existente (semantica de os.replace)."""
    import backend.app.downloader as dl

    lib = tmp_path / "lib"
    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setattr(dl, "LIBRARY", lib)
    monkeypatch.setattr(dl, "TEMP_DIR", temp)
    payload = bytearray(b"OggS" + b"\x00" * 8)

    async def falso(url, dest, progress=None):
        dest.write_bytes(bytes(payload))

    monkeypatch.setattr(dl, "_download_to", falso)

    primera = asyncio.run(dl.download_track(
        _track("https://example.org/tono.ogg"), "original"))
    payload[:] = b"OggS" + b"\x01" * 8
    segunda = asyncio.run(dl.download_track(
        _track("https://example.org/tono.ogg"), "original"))

    assert primera["path"] == segunda["path"]
    final = Path(segunda["path"])
    assert final.read_bytes() == b"OggS" + b"\x01" * 8
    assert [p.name for p in (lib / "Prueba").iterdir()] == [final.name]


# ------------------------------------------------------------ opciones yt-dlp
class YtDlpOptsFalso:
    """Doble de `yt_dlp.YoutubeDL` que registra opts y crea <home>/<stem>.mp3.

    Con TEMP_DIR el outtmpl es RELATIVO, asi que el destino se calcula
    combinando `paths.home` (que es lo que hace yt-dlp de verdad).
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


def test_sin_temp_dir_outtmpl_absoluto_y_sin_paths(yt_dlp_opts, tmp_path,
                                                   monkeypatch):
    import backend.app.downloader as dl

    lib = tmp_path / "lib"
    monkeypatch.setattr(dl, "LIBRARY", lib)
    monkeypatch.setattr(dl, "TEMP_DIR", None)

    res = _bajar("SinTemp")

    opts = yt_dlp_opts.opts_vistos[0]
    assert "paths" not in opts
    assert Path(opts["outtmpl"]).is_absolute()
    assert Path(res["path"]).parent == lib / "Artista"


def test_con_temp_dir_usa_paths_y_outtmpl_relativo(yt_dlp_opts, tmp_path,
                                                   monkeypatch):
    import backend.app.downloader as dl

    lib = tmp_path / "lib"
    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setattr(dl, "LIBRARY", lib)
    monkeypatch.setattr(dl, "TEMP_DIR", temp)

    res = _bajar("ConTemp")

    opts = yt_dlp_opts.opts_vistos[0]
    assert opts["paths"] == {"home": str(lib / "Artista"), "temp": str(temp)}
    # relativo a proposito: yt-dlp ignora `paths` con un outtmpl absoluto
    assert not Path(opts["outtmpl"]).is_absolute()
    assert "%(ext)s" in opts["outtmpl"]
    # el archivo final sigue cayendo en la carpeta del artista
    assert Path(res["path"]).parent == lib / "Artista"
