"""Cache de duracion y etiquetas del adapter local (sesion 20).

`/api/library` parseaba cada archivo con mutagen en cada llamada. Ahora la
lectura se guarda en `.spitifo/media-cache.sqlite3` por clave, tamano y mtime;
el `media-cache.json` viejo se migra una sola vez (`media_cache.py`).
"""
from __future__ import annotations

import json
import os
import sqlite3

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


def _cache(root):
    """Claves persistidas en la base de SQLite."""
    db = root / ".spitifo" / "media-cache.sqlite3"
    con = sqlite3.connect(db)
    try:
        return {f[0] for f in con.execute("SELECT key FROM media")}
    finally:
        con.close()


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

    assert _cache(tmp_path) == {"A/A - Uno.mp3"}


def test_una_cache_corrupta_se_ignora_y_se_reescribe(tmp_path, monkeypatch):
    _plantar(tmp_path, "A/A - Uno.mp3")
    (tmp_path / ".spitifo").mkdir()
    (tmp_path / ".spitifo" / "media-cache.sqlite3").write_bytes(b"no es sqlite")
    llamadas = _contar_lecturas(monkeypatch)

    (f,) = list(LocalStorage(tmp_path).list())
    assert f.key == "A/A - Uno.mp3"
    assert llamadas == ["A - Uno.mp3"]
    assert "A/A - Uno.mp3" in _cache(tmp_path)


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


def test_las_portadas_no_entran_en_la_cache_de_media(tmp_path):
    """Cada descarga trae dos portadas: con entrada en la cache triplicaban el JSON."""
    _plantar(tmp_path, "A/A - Uno.mp3")
    _plantar(tmp_path, "A/A - Uno.jpg")
    _plantar(tmp_path, "A/A - Uno.s.jpg")
    # Una entrada vieja de una portada se poda en el siguiente listado.
    storage = LocalStorage(tmp_path)
    listado = {f.key: f for f in storage.list()}
    assert set(listado) == {"A/A - Uno.mp3", "A/A - Uno.jpg", "A/A - Uno.s.jpg"}
    assert listado["A/A - Uno.jpg"].size == 64 and listado["A/A - Uno.jpg"].duration is None
    assert _cache(tmp_path) == {"A/A - Uno.mp3"}


# ---------------------------------------------------------------- migracion
def _json_viejo(tmp_path, fichas):
    state = tmp_path / ".spitifo"
    state.mkdir(exist_ok=True)
    (state / "media-cache.json").write_text(json.dumps(
        {"version": 2, "files": fichas}), encoding="utf-8")


def test_la_cache_json_vieja_se_migra_una_sola_vez(tmp_path, monkeypatch):
    llamadas = _contar_lecturas(monkeypatch)
    p = _plantar(tmp_path, "A/A - Uno.mp3")
    ficha = {"size": p.stat().st_size, "mtime": p.stat().st_mtime,
             "duration": 12.5, "title": "Uno", "artist": "A", "album": "B",
             "track_no": 1, "disc_no": None, "album_id": None}
    _json_viejo(tmp_path, {"A/A - Uno.mp3": ficha})

    (uno,) = list(LocalStorage(tmp_path).list())
    assert llamadas == [], "la ficha migrada evita volver a parsear el archivo"
    assert uno.duration == 12.5 and uno.title == "Uno"

    # La migracion retira el JSON y deja la base marcada: otra instancia no
    # vuelve a leerlo ni a duplicar filas.
    state = tmp_path / ".spitifo"
    assert not (state / "media-cache.json").exists()
    assert (state / "media-cache.json.migrated").exists()
    list(LocalStorage(tmp_path).list())
    assert _cache(tmp_path) == {"A/A - Uno.mp3"}


def test_una_migracion_cortada_se_reanuda_sin_perder_fichas(tmp_path, monkeypatch):
    """Si el proceso muere antes del commit, no hay marca de version: la
    siguiente apertura rehace la migracion desde el JSON, que sigue ahi."""
    llamadas = _contar_lecturas(monkeypatch)
    p = _plantar(tmp_path, "A/A - Uno.mp3")
    ficha = {"size": p.stat().st_size, "mtime": p.stat().st_mtime,
             "duration": 9.0, "title": None, "artist": None, "album": None,
             "track_no": None, "disc_no": None, "album_id": None}
    _json_viejo(tmp_path, {"A/A - Uno.mp3": ficha})
    # Simula el corte: la tabla existe pero no llego la marca de version.
    state = tmp_path / ".spitifo"
    con = sqlite3.connect(state / "media-cache.sqlite3")
    con.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")
    con.commit()
    con.close()

    (uno,) = list(LocalStorage(tmp_path).list())
    assert llamadas == []
    assert uno.duration == 9.0
    assert _cache(tmp_path) == {"A/A - Uno.mp3"}
