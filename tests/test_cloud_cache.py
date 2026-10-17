"""Tests OFFLINE de la cache de audio (backend/app/cloud/cache.py)."""
from __future__ import annotations

from pathlib import Path

from backend.app.cloud.cache import AudioCache, default_cache_dir


class Reloj:
    """Reloj inyectable: el orden LRU se controla sin dormir."""

    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _src(tmp_path: Path, name: str, data: bytes) -> Path:
    p = tmp_path / name
    p.write_bytes(data)
    return p


def test_put_y_get(tmp_path):
    cache = AudioCache(tmp_path / "cache", budget_bytes=1_000_000)
    dest = cache.put("id1", "rev1", _src(tmp_path, "a.mp3", b"audio"), ".mp3")
    assert dest.is_file()
    assert dest.suffix == ".mp3"

    got = cache.get("id1", "rev1")
    assert got == dest
    assert got.read_bytes() == b"audio"


def test_otra_revision_es_un_miss(tmp_path):
    cache = AudioCache(tmp_path / "cache", 1_000_000)
    cache.put("id1", "rev1", _src(tmp_path, "a.mp3", b"x"), ".mp3")
    assert cache.get("id1", "rev2") is None


def test_get_sin_entrada_es_none(tmp_path):
    cache = AudioCache(tmp_path / "cache", 1_000_000)
    assert cache.get("nadie", "nada") is None


def test_eviction_lru_usa_el_reloj_inyectado(tmp_path):
    reloj = Reloj()
    cache = AudioCache(tmp_path / "cache", budget_bytes=30, clock=reloj)
    cache.put("a", "1", _src(tmp_path, "a.bin", b"a" * 10), ".bin")
    reloj.t += 1
    cache.put("b", "1", _src(tmp_path, "b.bin", b"b" * 10), ".bin")
    reloj.t += 1
    cache.put("c", "1", _src(tmp_path, "c.bin", b"c" * 10), ".bin")
    reloj.t += 1
    # Se toca `a` para dejar a `b` como el menos usado recientemente.
    assert cache.get("a", "1") is not None
    reloj.t += 1
    cache.put("d", "1", _src(tmp_path, "d.bin", b"d" * 10), ".bin")

    assert cache.get("b", "1") is None  # el LRU salio
    assert cache.get("a", "1") is not None
    assert cache.get("c", "1") is not None
    assert cache.get("d", "1") is not None
    assert cache.size() <= 30


def test_pinned_nunca_se_evicta_aunque_sobre_el_presupuesto(tmp_path):
    reloj = Reloj()
    cache = AudioCache(tmp_path / "cache", budget_bytes=10, clock=reloj)
    cache.put("a", "1", _src(tmp_path, "a.bin", b"a" * 10), ".bin")
    cache.pin("a", "1")
    reloj.t += 1
    cache.put("b", "1", _src(tmp_path, "b.bin", b"b" * 10), ".bin")

    # `put` no evicta lo que acaba de guardar; la pasada siguiente si.
    cache.evict()
    assert cache.get("a", "1") is not None  # fijado: sobrevive
    assert cache.get("b", "1") is None      # el no fijado sale primero

    cache.unpin("a", "1")
    reloj.t += 1
    cache.put("c", "1", _src(tmp_path, "c.bin", b"c" * 10), ".bin")
    assert cache.get("a", "1") is None      # ya sin pin, es lo mas viejo
    assert cache.get("c", "1") is not None


def test_metadata_corrupta_reconstruye_y_borra_huerfanos(tmp_path):
    root = tmp_path / "cache"
    cache = AudioCache(root, 1_000_000)
    cache.put("id1", "rev1", _src(tmp_path, "a.bin", b"x" * 5), ".bin")
    # Un archivo suelto que nadie reclama y una metadata rota.
    (root / "huerfano.bin").write_bytes(b"basura")
    (root / "index.json").write_text("{no es json", encoding="utf-8")

    cache2 = AudioCache(root, 1_000_000)

    assert cache2.size() == 0
    assert cache2.get("id1", "rev1") is None
    assert not (root / "huerfano.bin").exists()
    assert (root / "index.json").exists()


def test_metadata_ausente_arranca_vacio(tmp_path):
    root = tmp_path / "cache"
    (root).mkdir(parents=True)
    (root / "suelto.bin").write_bytes(b"x")
    cache = AudioCache(root, 1_000_000)
    assert cache.size() == 0
    assert not (root / "suelto.bin").exists()


def test_default_cache_dir_usa_la_variable(monkeypatch, tmp_path):
    monkeypatch.setenv("SPITIFO_CACHE_DIR", str(tmp_path / "c"))
    assert default_cache_dir() == tmp_path / "c"


def test_un_archivo_mas_grande_que_el_presupuesto_no_se_borra_solo(tmp_path):
    # `put` devuelve la ruta: no puede evictar la entrada que acaba de guardar.
    reloj = Reloj()
    cache = AudioCache(tmp_path / "cache", budget_bytes=4, clock=reloj)
    viejo = cache.put("a", "r", _src(tmp_path, "a.mp3", b"123"), ".mp3")
    reloj.t += 1
    grande = cache.put("b", "r", _src(tmp_path, "b.mp3", b"0123456789"), ".mp3")
    assert grande.is_file()
    assert not viejo.exists()
    assert cache.get("b", "r") == grande


def test_archivos_huerfanos_se_borran_con_indice_sano(tmp_path):
    root = tmp_path / "cache"
    cache = AudioCache(root, 1_000_000)
    bueno = cache.put("id1", "rev1", _src(tmp_path, "a.mp3", b"x"), ".mp3")
    huerfano = root / ("f" * 64 + ".mp3")
    huerfano.write_bytes(b"sin indice")
    parcial = root / ("e" * 64 + ".mp3.part")
    parcial.write_bytes(b"corte a mitad")

    reabierta = AudioCache(root, 1_000_000)
    assert reabierta.get("id1", "rev1") == bueno
    assert not huerfano.exists()
    assert not parcial.exists()
