"""Conversion con ffmpeg y escritura de tags: local, sin red.

Cubre offline lo que `test_convert.py` y `test_wav.py` authenticaban contra
internet: que la rama de conversion produzca un MP3 real y con nombre correcto,
y que los tags se escriban. La diferencia es que aca el audio es sintetico con
ffmpeg, asi que la suite no depende de que archive.org ni Wikimedia esten
arriba ni de que sus items tengan el formato que toca hoy.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from mutagen import File as MFile
from mutagen.id3 import TALB, TDRC, TIT2, TPE1

from backend.app.downloader import (
    NEEDS_FFMPEG,
    _ffmpeg_ok,
    _ffmpeg_convert,
    _write_tags,
    library_scan,
)
from backend.app.models import Track, safe_name

from conftest import ffprobe_duracion


def test_ffmpeg_esta_disponible():
    assert _ffmpeg_ok() is True


@pytest.mark.parametrize("ext", [".wav", ".ogg", ".opus", ".flac"])
def test_needs_ffmpeg_cubre_los_formatos_que_no_son_mp3(ext):
    """Estos 4 son los que la app sabe convertir; un mp3 entra directo."""
    assert ext in NEEDS_FFMPEG
    assert ".mp3" not in NEEDS_FFMPEG


# ------------------------------------------------------------- _ffmpeg_convert
def test_ffmpeg_convert_wav_a_mp3(wav_sintetico, tmp_path):
    """WAV -> MP3: el archivo existe, no esta vacio y ffprobe lo puede medir."""
    salida = tmp_path / "tono.mp3"
    resultado = _ffmpeg_convert(wav_sintetico, salida)

    assert resultado == salida
    assert salida.exists()
    assert salida.stat().st_size > 0

    # el resultado es un MP3 real, no el WAV renombrado
    assert MFile(salida) is not None
    assert MFile(salida).info.length == pytest.approx(3.0, abs=0.2)
    assert ffprobe_duracion(salida) == pytest.approx(3.0, abs=0.2)


def test_ffmpeg_convert_respeta_el_nombre_final(wav_sintetico, tmp_path):
    """El nombre final lo decide el caller, no el tmp de entrada.

    Si `_ffmpeg_convert` derivara el nombre del src quedaria un `.a1b2c3d4.mp3`
    en vez de `artista - titulo.mp3` (la trampa que costo una sesion).
    """
    salida = tmp_path / "Metallica - Enter Sandman.mp3"
    _ffmpeg_convert(wav_sintetico, salida)
    assert salida.exists()
    assert [p.name for p in tmp_path.iterdir()] == ["Metallica - Enter Sandman.mp3"]


# --------------------------------------------------------------- _write_tags
def test_write_tags_en_mp3(mp3_desde_wav):
    """El MP3 convertido tiene que quedar con TIT2/TPE1/TALB/TDRC."""
    t = Track(source="x", source_id="1", title="Numb", artist="Linkin Park",
              album="Hybrid Theory", year="2000", license="CC BY-SA")
    _write_tags(mp3_desde_wav, t)

    tags = MFile(mp3_desde_wav).tags
    assert tags is not None
    assert tags["TIT2"].text == ["Numb"]
    assert tags["TPE1"].text == ["Linkin Park"]
    assert tags["TALB"].text == ["Hybrid Theory"]
    assert str(tags["TDRC"].text[0]).startswith("2000")


def test_write_tags_no_rompe_el_audio(mp3_desde_wav):
    """Escribir tags no puede alterar el audio: ffprobe sigue dando 3s."""
    antes = ffprobe_duracion(mp3_desde_wav)
    _write_tags(mp3_desde_wav, Track(source="x", source_id="1",
                                    title="Numb", artist="Linkin Park"))
    assert ffprobe_duracion(mp3_desde_wav) == pytest.approx(antes, abs=0.1)


def test_write_tags_ignora_extension_desconocida(tmp_path):
    """Un .txt no es audio: los tags son un extra, no pueden tumbar la descarga."""
    p = tmp_path / "notas.txt"
    p.write_text("hola", encoding="utf-8")
    _write_tags(p, Track(source="x", source_id="1", title="N", artist="A"))
    assert p.read_text(encoding="utf-8") == "hola"  # intacto


# ----------------------------------------------------------------- safe_name
@pytest.mark.parametrize("entrada,esperado", [
    # caracteres que Windows no acepta en un nombre de archivo
    ("Numb: the /best*? \"one\"", "Numb the best one"),
    ("Metallica - Enter Sandman", "Metallica - Enter Sandman"),
    ("  .  ", "untitled"),
])
def test_safe_name(entrada, esperado):
    assert safe_name(entrada) == esperado


def test_safe_name_recorta_lo_largo():
    assert len(safe_name("a" * 120, 100)) == 100


# --------------------------------------------------------------- library_scan
def test_library_scan_mide_duracion_con_mutagen(mp3_desde_wav, monkeypatch, biblioteca):
    """`/api/library` muestra duracion real leida con mutagen, no un invento."""
    import backend.app.downloader as dl

    destino = biblioteca / "Linkin Park"
    destino.mkdir(parents=True, exist_ok=True)
    copia = destino / "Numb.mp3"
    copia.write_bytes(mp3_desde_wav.read_bytes())
    monkeypatch.setattr(dl, "LIBRARY", biblioteca)

    archivos = dl.library_scan()
    entry = next(f for f in archivos if f["filename"] == "Numb.mp3")
    assert entry["duration_s"] == pytest.approx(3.0, abs=0.2)
    assert entry["bytes"] > 0
