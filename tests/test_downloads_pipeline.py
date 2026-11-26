"""Correcciones del pipeline de descargas (round4-perf, phase 8).

Todo OFFLINE: `FakeDrive`, storage local temporal y yt-dlp doble. Cubre:

- fases de red / CPU separadas (P-downloads-pipeline-1);
- fase «uploading» con progreso propio (P-downloads-pipeline-3);
- formato original/mp3 y coste de la conversion (P-downloads-pipeline-4);
- portadas que no retrasan el `done` (P-downloads-pipeline-5);
- veredicto en el mismo lote de subida (P-downloads-pipeline-6);
- journal append-only, compactacion y recuperacion tras corte;
- compuerta de Wi-Fi / roaming (R2).
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
import types
import sys
from pathlib import Path

import httpx
import pytest

from backend.app import downloads
from backend.app.cloud.drive import DriveStorage
from backend.app.cloud.index_journal import (COMPACT_ENTRIES, IndexJournal,
                                             journal_path)
from backend.app.cloud.library_index import LibraryIndex
from backend.app.models import Track
from backend.app.ytdlp_source import (COVER_WAIT_S, is_transcode,
                                      media_opts, postprocessor_opts)
from fake_drive import FakeDrive


class _FakeTokens:
    def access_token(self) -> str:
        return "test-token"


def _storage(fake: FakeDrive, tmp_path: Path, device: str = "A") -> DriveStorage:
    client = httpx.Client(transport=httpx.MockTransport(fake))
    return DriveStorage(_FakeTokens(), client, device,
                        journal_dir=tmp_path / "data")


def _origen(tmp_path: Path, key: str, data: bytes) -> Path:
    src = tmp_path / f"origen-{key.replace('/', '_')}"
    src.write_bytes(data)
    return src


def _indices(fake: FakeDrive) -> list[dict]:
    return [f for f in fake.files.values() if f["name"].startswith("index-")]


# -------------------------------------------------------------- fases / cpu
def test_fase_de_red_y_cpu_estan_separadas():
    assert downloads.MAX_NETWORK == 4
    assert downloads.MAX_TRANSCODE == 2
    assert is_transcode("mp3", "audio") is True
    assert is_transcode("m4a", "audio") is False
    assert is_transcode("original", "audio") is False
    # videos/both no recodifican audio aunque el fmt diga mp3
    assert is_transcode("mp3", "both") is False


def test_original_y_m4a_no_recodifican_mp3_si():
    assert postprocessor_opts("original")[0]["preferredcodec"] == "best"
    assert postprocessor_opts("m4a")[0]["preferredcodec"] == "m4a"
    assert media_opts("audio", "m4a")["format"].startswith("bestaudio[ext=m4a]")
    # mp3 sigue disponible, pero es una eleccion explicita y costosa
    assert postprocessor_opts("mp3")[0]["preferredcodec"] == "mp3"


# ------------------------------------------------------------------ journal
def test_journal_es_append_only_y_lineas_rotas_se_ignoran(tmp_path):
    jp = journal_path(tmp_path / "data", "A")
    journal = IndexJournal(jp, clock=lambda: 1000.0)
    e = LibraryIndex()
    from backend.app.cloud.library_index import IndexEntry
    entry = IndexEntry(key="A/x.mp3", remote_id="r1", revision="1",
                       title="x", artist="a", album="b", duration=1.0,
                       size=10, format="mp3", updated_at=1.0)
    journal.append([entry])
    raw = jp.read_bytes()
    assert raw.endswith(b"\n")
    (obj,) = [json.loads(line) for line in raw.splitlines()]
    assert obj["k"] == "A/x.mp3" and obj["e"]["remote_id"] == "r1"
    # Simula un corte a mitad de la siguiente linea: no debe romper la lectura.
    with open(jp, "ab") as f:
        f.write(b'{"v":1,"n":2,"k":"A/y')
    assert set(journal.load()) == {"A/x.mp3"}
    journal.drop_applied(1)
    assert journal.load() == {}


def test_una_descarga_no_resube_el_indice_y_la_compactacion_lo_hace_una_vez(tmp_path):
    fake = FakeDrive()
    storage = _storage(fake, tmp_path)
    src = _origen(tmp_path, "A/x.mp3", b"0123456789")

    storage.put_files([("A/x.mp3", src)], journal=True)
    assert _indices(fake) == [], "el indice no se reescribe por cada descarga"
    assert storage.journal_stats()["pending"] == 1
    assert "A/x.mp3" in {f.key for f in storage.list()}, "en memoria ya se ve"

    storage.compact_index_journal()
    indices = _indices(fake)
    assert len(indices) == 1
    assert "A/x.mp3" in LibraryIndex.from_bytes(
        fake.data_of(next(iter(
            fid for fid, f in fake.files.items()
            if f["name"] == "index-A.json")))).entries
    assert storage.journal_stats()["pending"] == 0


def test_reinicio_ve_todo_lo_ya_subido_sin_que_se_cerrara_la_tanda(tmp_path):
    """Corte a mitad de un grupo: el journal local basta para recuperar las
    pistas cuyo archivo ya esta completo en la nube."""
    fake = FakeDrive()
    primero = _storage(fake, tmp_path)
    for i in range(3):
        key = f"A/t{i}.mp3"
        primero.put_files([(key, _origen(tmp_path, key, bytes([i] * 10)))],
                          journal=True)
    assert _indices(fake) == []

    # Proceso nuevo, MISMO dir de datos y dispositivo: nada se perdio.
    reiniciado = _storage(fake, tmp_path)
    assert {f.key for f in reiniciado.list()} == {
        f"A/t{i}.mp3" for i in range(3)}
    reiniciado.compact_index_journal()
    assert len(_indices(fake)) == 1


def test_dos_grupos_terminando_juntos_no_pierden_cambios(tmp_path):
    fake = FakeDrive()
    storage = _storage(fake, tmp_path)
    barrera = threading.Barrier(2)

    def subir(i: int) -> None:
        key = f"A/g{i}.mp3"
        barrera.wait()
        storage.put_files([(key, _origen(tmp_path, key, bytes([i] * 8)))],
                          journal=True)

    hilos = [threading.Thread(target=subir, args=(i,)) for i in range(2)]
    for h in hilos:
        h.start()
    for h in hilos:
        h.join()

    storage.compact_index_journal()
    indice = LibraryIndex.from_bytes(fake.data_of(next(iter(
        fid for fid, f in fake.files.items() if f["name"] == "index-A.json"))))
    assert {"A/g0.mp3", "A/g1.mp3"} <= set(indice.entries)
    assert storage.journal_stats()["pending"] == 0


def test_batch_index_writes_con_journal_sube_el_indice_una_sola_vez(tmp_path):
    """Las pistas de un grupo comparten tanda: una subida del indice al final."""
    fake = FakeDrive()
    storage = _storage(fake, tmp_path)
    with storage.batch_index_writes():
        for i in range(3):
            key = f"A/b{i}.mp3"
            storage.put_files([(key, _origen(tmp_path, key, b"x" * (i + 1)))],
                              journal=True)
        assert _indices(fake) == []
    assert len(_indices(fake)) == 1


# ------------------------------------------------------------- fase de subida
class _YtDlpDoble:
    titulo = "Numb - Linkin Park"

    def __init__(self, opts):
        self.opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=True):
        destino = Path(self.opts["paths"]["home"]) / (
            self.opts["outtmpl"].replace("%(ext)s", "m4a"))
        destino.write_bytes(b"ID3\x03\x00\x00\x00" + b"\x00" * 200)
        return {"filepath": destino, "title": self.titulo,
                "uploader": "Linkin Park", "duration": 187, "id": "abc"}


@pytest.fixture
def ytdlp(monkeypatch, tmp_path, storage_temporal):
    modulo = types.ModuleType("yt_dlp")
    modulo.YoutubeDL = _YtDlpDoble
    monkeypatch.setitem(sys.modules, "yt_dlp", modulo)
    from backend.app import downloader as dl
    from backend.app import ytdlp_source as ys
    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setattr(dl, "TEMP_DIR", temp)
    ys._LOCKS_POR_RUTA.clear()
    yield storage_temporal(tmp_path / "lib")
    ys._LOCKS_POR_RUTA.clear()


def _numb() -> Track:
    return Track(source="ytdlp", source_id="abc", title="Numb",
                 artist="Linkin Park", album="Meteora",
                 extra={"webpage_url": "https://www.youtube.com/watch?v=abc"})


def test_la_fase_de_subida_publica_progreso_propio(ytdlp, monkeypatch):
    """Mientras se sube el archivo, el job no dice 100 %: dice `uploading`
    con un porcentaje que avanza con los bytes."""
    from backend.app import ytdlp_source as ys
    visto = {}

    original = ytdlp.put_file

    def espia(key, src):
        job = ys.get_job(job_id) or {}
        visto["fase"] = job.get("phase")
        visto["progreso"] = job.get("progress")
        return original(key, src)

    # `put_file` no es el que usa la descarga, así que espiamos `put_files`.
    original_files = ytdlp.put_files

    def espia_files(items, **kw):
        cb = kw.get("on_bytes")
        if cb:
            cb(1, 2)
        job = ys.get_job(job_id) or {}
        visto["fase"] = job.get("phase")
        visto["progreso"] = job.get("progress")
        kw["journal"] = False
        return original_files(items, **kw)

    monkeypatch.setattr(ytdlp, "put_files", espia_files)
    job_id = ys.new_job("Numb")
    resultado = asyncio.run(ys.YtDlpSource().download(
        _numb(), "original", job_id=job_id))

    assert visto["fase"] == "uploading"
    assert visto["progreso"] == 50.0
    assert resultado["key"].endswith(".m4a")


def test_el_veredicto_entra_en_el_mismo_lote_que_el_audio(ytdlp, monkeypatch):
    """No hay un segundo PUT serial del shard justo despues de subir el audio."""
    from backend.app import ytdlp_source as ys
    dentro = []
    original_files = ytdlp.put_files

    def espia(items, **kw):
        assert kw.get("fileinfo") is not None, "el veredicto va en el lote"
        dentro.append(True)
        kw["journal"] = False
        return original_files(items, **kw)

    monkeypatch.setattr(ytdlp, "put_files", espia)
    asyncio.run(ys.YtDlpSource().download(_numb(), "original"))
    assert dentro == [True]


def test_una_portada_lenta_no_retrasan_el_done(ytdlp, monkeypatch):
    """Si el CDN tarda mas que `COVER_WAIT_S`, el tema se marca done igual."""
    from backend.app import covers
    from backend.app import ytdlp_source as ys

    async def lenta(client, url):
        await asyncio.sleep(COVER_WAIT_S + 2.0)
        return b"\xff\xd8\xff\xe0" + b"\x00" * 40

    monkeypatch.setattr(covers, "_get", lenta)
    track = _numb()
    track.artwork_url = "https://is1-ssl.mzstatic.com/image/thumb/x/300x300bb.jpg"
    track.extra["from_itunes"] = True
    t0 = time.monotonic()
    res = asyncio.run(ys.YtDlpSource().download(track, "original"))
    assert time.monotonic() - t0 < COVER_WAIT_S + 1.0, (
        "esperar al CDN lento completo habria tardado mas de 3 s")
    assert res["thumb_key"] is None


# --------------------------------------------------------------- red / Wi-Fi
def test_espera_wifi_y_arranca_cuando_vuelve(monkeypatch):
    """Un item con «solo Wi-Fi» espera con fase visible y arranca al volver."""
    from backend.app import ytdlp_source as ys

    intentos = []

    async def falso(self, track, fmt, **kw):
        intentos.append(kw.get("job_id"))
        return {"key": "A/x.m4a", "filename": "x.m4a", "bytes": 10,
                "size_mb": 0.01, "format": "M4A"}

    monkeypatch.setattr(ys.YtDlpSource, "download", falso)
    monkeypatch.setattr(downloads, "NETWORK_CHECK_S", 0.01)
    downloads.reset_for_tests()
    try:
        downloads.set_network(type="cellular", wifi_only=True)
        track = Track(source="ytdlp", source_id="x", title="x", artist="a")
        (item,) = downloads.enqueue([{
            "source": "ytdlp", "track": track.to_dict(),
            "fmt": "original", "media": "audio", "key_base": "A/x",
        }])

        async def correr():
            # `enqueue` se llamo fuera del loop, asi que agenda el worker aca.
            downloads._schedule(item["id"])
            await asyncio.sleep(0.05)
            estado = downloads.get_item(item["id"])
            assert estado["status"] == "queued"
            assert estado["phase"] == "waiting_wifi"
            downloads.set_network(type="wifi")
            await downloads.wait_item(item["id"], timeout=2)

        asyncio.run(correr())
        assert intentos == [item["id"]]
    finally:
        downloads.reset_for_tests()


def test_roaming_se_puede_prohibir():
    downloads.reset_for_tests()
    try:
        downloads.set_network(type="roaming", roaming_allowed=False)
        assert downloads._network_wait() == "waiting_roaming"
        downloads.set_network(roaming_allowed=True)
        assert downloads._network_wait() is None
        downloads.set_network(type="cellular", wifi_only=True)
        assert downloads._network_wait() == "waiting_wifi"
        downloads.set_network(type="unknown")
        assert downloads._network_wait() is None, "sin saber el tipo no se bloquea"
    finally:
        downloads.reset_for_tests()
