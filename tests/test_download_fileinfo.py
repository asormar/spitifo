"""Las descargas dejan su veredicto y procedencia (`downloader.record_download`).

Todo OFFLINE: la bajada de `download_track` se reemplaza por una funcion falsa y
yt-dlp por un `yt_dlp.YoutubeDL` doble en `sys.modules` (mismo truco que
test_temp_dir.py).
"""
from __future__ import annotations

import asyncio
import sys
import time
import types
from pathlib import Path

import pytest

from backend.app.models import Track
from backend.app.storage.local import LocalStorage


def _preparar_descarga(monkeypatch, tmp_path, storage_temporal):
    import backend.app.downloader as dl

    async def falso(url, dest, progress=None):
        dest.write_bytes(b"OggS" + b"\x00" * 60)
        return dest

    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setattr(dl, "_download_to", falso)
    monkeypatch.setattr(dl, "TEMP_DIR", temp)
    return dl, storage_temporal(tmp_path / "lib")


def _archive(**extra) -> Track:
    base = {"match": "match", "real_title": "Tono", "title_source": "tags",
            "item_url": "https://archive.org/details/x"}
    base.update(extra)
    return Track(source="archive", source_id="x", title="Tono", artist="Prueba",
                 audio_url="https://example.org/tono.ogg", extra=base)


# ------------------------------------------------------------- download_track
def test_download_track_guarda_el_registro_con_el_tamano_guardado(
        tmp_path, monkeypatch, storage_temporal):
    dl, storage = _preparar_descarga(monkeypatch, tmp_path, storage_temporal)

    res = asyncio.run(dl.download_track(_archive(), "original"))

    registro = storage.load_fileinfo()[res["key"]]
    assert registro["bytes"] == res["bytes"] == 64
    assert registro["verdict"] == "match"
    assert registro["meta"] == registro["file"] == "archive"


def test_un_archivo_cambiado_de_nombre_guarda_lo_buscado_y_lo_real(
        tmp_path, monkeypatch, storage_temporal):
    dl, storage = _preparar_descarga(monkeypatch, tmp_path, storage_temporal)
    track = _archive(match="mismatch", real_title="Ghost>",
                     real_artist="Phish")

    res = asyncio.run(dl.download_track(track, "original"))

    assert res["key"] == "Phish/Phish - Ghost>.ogg".replace(">", "")
    registro = storage.load_fileinfo()[res["key"]]
    assert registro["title"] == "Tono" and registro["real"] == "Ghost>"
    assert registro["verdict"] == "mismatch"


def test_si_el_registro_no_se_puede_guardar_la_descarga_sigue(
        tmp_path, monkeypatch, storage_temporal):
    dl, storage = _preparar_descarga(monkeypatch, tmp_path, storage_temporal)

    def roto(key, record):
        raise RuntimeError("sin disco")

    monkeypatch.setattr(storage, "save_fileinfo", roto)
    res = asyncio.run(dl.download_track(_archive(), "original"))

    assert (tmp_path / "lib" / res["key"]).exists()
    assert storage.load_fileinfo() == {}


# ------------------------------------------------------------------- yt-dlp
class YtDlpDoble:
    """Doble de `yt_dlp.YoutubeDL`: crea <home>/<stem>.mp3 y devuelve el info."""

    titulo = "Numb (Official Video) - Linkin Park"

    def __init__(self, opts):
        self.opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=True):
        destino = Path(self.opts["paths"]["home"]) / (
            self.opts["outtmpl"].replace("%(ext)s", "mp3"))
        destino.write_bytes(b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x00" * 200)
        return {"filepath": destino, "title": type(self).titulo,
                "uploader": "Linkin Park", "duration": 187, "id": "abc"}


@pytest.fixture
def ytdlp(monkeypatch, tmp_path, storage_temporal):
    modulo = types.ModuleType("yt_dlp")
    modulo.YoutubeDL = YtDlpDoble
    monkeypatch.setitem(sys.modules, "yt_dlp", modulo)
    from backend.app import downloader as dl
    from backend.app import ytdlp_source as ys

    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setattr(dl, "TEMP_DIR", temp)
    ys._LOCKS_POR_RUTA.clear()
    yield storage_temporal(tmp_path / "lib")
    ys._LOCKS_POR_RUTA.clear()


def _numb(**extra) -> Track:
    return Track(source="ytdlp", source_id="abc", title="Numb",
                 artist="Linkin Park", album="Meteora", year="2003",
                 extra={"webpage_url": "https://www.youtube.com/watch?v=abc",
                        "item_url": "https://music.apple.com/ar/song/1",
                        "from_itunes": True, **extra})


def _bajar(track, query):
    from backend.app.ytdlp_source import YtDlpSource, new_job

    job = new_job(track.title)
    return asyncio.run(YtDlpSource().download(track, job_id=job, query=query))


def test_ytdlp_guarda_ficha_de_itunes_y_archivo_de_youtube(ytdlp):
    res = _bajar(_numb(), "numb linkin park")

    registro = ytdlp.load_fileinfo()[res["key"]]
    assert registro["meta"] == "itunes" and registro["file"] == "youtube"
    assert registro["verdict"] == "match"
    assert registro["bytes"] == res["bytes"]
    assert registro["real"] == YtDlpDoble.titulo and registro["real_by"] == "video"


def test_ytdlp_con_un_enlace_pegado_guarda_unknown(ytdlp):
    res = _bajar(_numb(), "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    assert ytdlp.load_fileinfo()[res["key"]]["verdict"] == "unknown"


def test_ytdlp_guarda_el_registro_antes_de_marcar_done(ytdlp, monkeypatch):
    """Quien hace polling ve `done` recien cuando el registro ya existe."""
    from backend.app.ytdlp_source import get_job

    visto: dict = {}
    original = ytdlp.save_fileinfo

    def espia(key, record):
        visto["estado"] = (get_job(job_id) or {}).get("status")
        original(key, record)

    monkeypatch.setattr(ytdlp, "save_fileinfo", espia)
    from backend.app.ytdlp_source import YtDlpSource, new_job
    job_id = new_job("Numb")
    asyncio.run(YtDlpSource().download(_numb(), job_id=job_id,
                                       query="numb linkin park"))

    assert visto["estado"] not in ("done", "error", None)
    assert get_job(job_id)["status"] == "done"


def test_ytdlp_sigue_si_el_registro_falla(ytdlp, monkeypatch):
    def roto(key, record):
        raise RuntimeError("sin disco")

    monkeypatch.setattr(ytdlp, "save_fileinfo", roto)
    res = _bajar(_numb(), "numb linkin park")
    assert (ytdlp.root / res["key"]).exists()


# ------------------------------------------------------------------- portadas
JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 60
ARTE = ("https://is1-ssl.mzstatic.com/image/thumb/Music/v4/ab/source/"
        "300x300bb.jpg")


@pytest.fixture
def portadas(monkeypatch):
    """Reemplaza la bajada de portadas: anota las URLs y devuelve un jpg."""
    from backend.app import covers

    pedidas: list[str] = []

    async def falso(client, url):
        pedidas.append(url)
        return JPG + url.encode()

    monkeypatch.setattr(covers, "_get", falso)
    return pedidas


def test_la_descarga_guarda_las_dos_portadas_junto_al_audio(ytdlp, portadas):
    res = _bajar(_numb_con_arte(), "numb")

    raiz = Path(ytdlp.root)
    base = res["key"].rsplit(".", 1)[0]
    assert (raiz / f"{base}.jpg").read_bytes().endswith(b"200x200bb.jpg")
    assert (raiz / f"{base}.s.jpg").read_bytes().endswith(b"100x100bb.jpg")
    assert res["thumb_key"] == f"{base}.jpg"
    assert sorted(portadas) == [ARTE.replace("300x300", "100x100"),
                                ARTE.replace("300x300", "200x200")]

    from backend.app.downloader import library_scan
    (fila,) = [f for f in library_scan() if f["key"] == res["key"]]
    assert fila["thumb_key"] == f"{base}.jpg" and fila["thumb_s"] is True


def _numb_con_arte() -> Track:
    t = _numb()
    t.artwork_url = ARTE
    return t


def test_una_portada_que_falla_no_tumba_la_descarga(ytdlp, monkeypatch):
    from backend.app import covers

    async def roto(client, url):
        raise RuntimeError("iTunes no contesta")

    monkeypatch.setattr(covers, "_get", roto)
    res = _bajar(_numb_con_arte(), "numb")

    assert (ytdlp.root / res["key"]).exists()
    assert res["thumb_key"] is None
    assert not list(Path(ytdlp.root).rglob("*.jpg"))


def test_sin_ficha_de_itunes_no_se_baja_ninguna_portada(ytdlp, portadas):
    track = _numb_con_arte()
    track.extra["from_itunes"] = False
    res = _bajar(track, "numb")

    assert portadas == [] and res["thumb_key"] is None


def test_si_falla_al_guardar_las_portadas_el_audio_queda(ytdlp, portadas,
                                                         monkeypatch):
    original = ytdlp.put_file
    estado = {"n": 0}

    def a_medias(key, src):
        estado["n"] += 1
        if estado["n"] == 2:
            raise OSError("sin espacio")
        return original(key, src)

    monkeypatch.setattr(ytdlp, "put_file", a_medias)
    res = _bajar(_numb_con_arte(), "numb")

    assert (ytdlp.root / res["key"]).exists()
    assert res["thumb_key"] is None


def test_las_portadas_se_piden_mientras_yt_dlp_baja(ytdlp, portadas, monkeypatch):
    """La descarga no espera a las portadas al final: ya estan pedidas cuando yt-dlp corre."""
    visto: dict = {}
    original = YtDlpDoble.extract_info

    def espia(self, url, download=True):
        # Corre en un hilo: el bucle del evento atiende el pedido de portadas.
        for _ in range(100):
            if len(portadas) == 2:
                break
            time.sleep(0.01)
        visto["pedidas"] = len(portadas)
        return original(self, url, download=download)

    monkeypatch.setattr(YtDlpDoble, "extract_info", espia)
    res = _bajar(_numb_con_arte(), "numb")

    assert visto["pedidas"] == 2
    assert res["thumb_key"] is not None
