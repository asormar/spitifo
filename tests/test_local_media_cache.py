"""Cache de duracion y etiquetas del adapter local (sesion 20).

`/api/library` parseaba cada archivo con mutagen en cada llamada. Ahora la
lectura se guarda en `.spitifo/media-cache.json` por clave, tamano y mtime.
"""
from __future__ import annotations

import json
import os

import backend.app.storage.local as local
from backend.app.storage.local import LocalStorage


def _contar_lecturas(monkeypatch):
    llamadas = []
    real = local._media_info

    def espia(p):
        llamadas.append(p.name)
        return real(p)

    monkeypatch.setattr(local, "_media_info", espia)
    return llamadas


def _plantar(root, key, data=b"\x00" * 64):
    p = root / key
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return p


def test_el_segundo_listado_no_vuelve_a_parsear(tmp_path, monkeypatch):
    llamadas = _contar_lecturas(monkeypatch)
    _plantar(tmp_path, "A/A - Uno.mp3")
    _plantar(tmp_path, "A/A - Dos.mp3")

    list(LocalStorage(tmp_path).list())
    assert sorted(llamadas) == ["A - Dos.mp3", "A - Uno.mp3"]

    # Otra instancia (otro arranque de la app): lee la cache del disco.
    llamadas.clear()
    list(LocalStorage(tmp_path).list())
    assert llamadas == []


def test_un_archivo_cambiado_se_vuelve_a_leer(tmp_path, monkeypatch):
    llamadas = _contar_lecturas(monkeypatch)
    p = _plantar(tmp_path, "A/A - Uno.mp3")
    storage = LocalStorage(tmp_path)
    list(storage.list())

    llamadas.clear()
    p.write_bytes(b"\x00" * 128)
    os.utime(p, (p.stat().st_atime, p.stat().st_mtime + 10))
    list(storage.list())
    assert llamadas == ["A - Uno.mp3"]


def test_una_clave_borrada_sale_de_la_cache(tmp_path):
    _plantar(tmp_path, "A/A - Uno.mp3")
    p = _plantar(tmp_path, "A/A - Dos.mp3")
    storage = LocalStorage(tmp_path)
    list(storage.list())
    p.unlink()
    list(storage.list())

    cache = json.loads((tmp_path / ".spitifo" / "media-cache.json").read_text())
    assert set(cache["files"]) == {"A/A - Uno.mp3"}


def test_una_cache_corrupta_se_ignora_y_se_reescribe(tmp_path, monkeypatch):
    _plantar(tmp_path, "A/A - Uno.mp3")
    (tmp_path / ".spitifo").mkdir()
    (tmp_path / ".spitifo" / "media-cache.json").write_text("{no es json")
    llamadas = _contar_lecturas(monkeypatch)

    (f,) = list(LocalStorage(tmp_path).list())
    assert f.key == "A/A - Uno.mp3"
    assert llamadas == ["A - Uno.mp3"]
    cache = json.loads((tmp_path / ".spitifo" / "media-cache.json").read_text())
    assert "A/A - Uno.mp3" in cache["files"]


def test_las_miniaturas_no_se_abren_con_mutagen(tmp_path, monkeypatch):
    llamadas = _contar_lecturas(monkeypatch)
    _plantar(tmp_path, "A/A - Uno.jpg")
    list(LocalStorage(tmp_path).list())
    assert llamadas == []


def test_la_cache_conserva_las_etiquetas(tmp_path, mp3_desde_wav):
    from mutagen.easyid3 import EasyID3
    from mutagen.id3 import ID3NoHeaderError

    p = tmp_path / "Ñu" / "Ñu - Canción.mp3"
    p.parent.mkdir()
    p.write_bytes(mp3_desde_wav.read_bytes())
    try:
        tags = EasyID3(str(p))
    except ID3NoHeaderError:
        tags = EasyID3()
    tags["title"] = "Canción"
    tags["artist"] = "Ñu"
    tags["album"] = "Uno"
    tags.save(str(p))

    (primero,) = list(LocalStorage(tmp_path).list())
    (segundo,) = list(LocalStorage(tmp_path).list())
    assert (segundo.title, segundo.artist, segundo.album) == ("Canción", "Ñu", "Uno")
    assert segundo.duration == primero.duration
