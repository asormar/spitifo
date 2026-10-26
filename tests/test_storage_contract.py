"""Contrato del puerto `Storage`: el mismo para TODOS los adapters.

El adapter de disco (`LocalStorage`) es el unico de hoy, pero los tests estan
parametrizados sobre el fixture `storage`: sumar un adapter a `ADAPTERS` alcanza
para que herede toda la bateria (docs/adr/0002-user-owned-storage.md, seccion 9).

Todo OFFLINE: se escribe en la subcarpeta temporal de cada adapter.
"""
from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest

from backend.app.storage import InvalidKey, StoredFile, validate_key
from backend.app.storage.local import LocalStorage

#: Adapters que tiene que cumplir el contrato. Agregar uno es una linea.
ADAPTERS = ("local", "drive")


class _FakeTokens:
    """Origen de tokens de prueba: siempre el mismo, sin red."""

    def access_token(self) -> str:
        return "test-token"

    def invalidate(self) -> None:
        pass


def _drive_storage(tmp_path: Path):
    """`DriveStorage` sobre el Drive falso, con cache en `tmp_path`."""
    from fake_drive import FakeDrive
    from backend.app.cloud.cache import AudioCache
    from backend.app.cloud.drive import DriveStorage

    client = httpx.Client(transport=httpx.MockTransport(FakeDrive()))
    cache = AudioCache(tmp_path / "cache", budget_bytes=256 * 1024 * 1024)
    return DriveStorage(_FakeTokens(), client, "contract", cache=cache,
                        sleep=lambda _s: None)


@pytest.fixture(params=sorted(ADAPTERS))
def adapter(request, tmp_path):
    """(nombre, adapter) por parametro. La raiz local vive en `tmp_path/root`."""
    root = tmp_path / "root"
    root.mkdir()
    if request.param == "local":
        return request.param, LocalStorage(root)
    return request.param, _drive_storage(tmp_path)


@pytest.fixture
def storage(adapter):
    return adapter[1]


@pytest.fixture
def adapter_name(adapter):
    return adapter[0]


def _origen(tmp_path: Path, data: bytes) -> Path:
    """Archivo fuente para `put_file` FUERA de la raiz (para poder moverlo)."""
    src = tmp_path / f"origen-{os.urandom(4).hex()}.mp3"
    src.write_bytes(data)
    return src


def _poner(storage, tmp_path: Path, key: str, data: bytes) -> str:
    storage.put_file(key, _origen(tmp_path, data))
    return key


# ------------------------------------------------------------------- validacion
CLAVES_INVALIDAS = [
    "../x.mp3", "/abs.mp3", "a\\b.mp3", "C:/x.mp3", "a//b.mp3", "./a.mp3",
    "a/../b.mp3", "a/", "/", "", '"', "a\x00b.mp3", "a/\x01b.mp3",
    "a?b.mp3", "*", "x" * 1025,
]


@pytest.mark.parametrize("clave", CLAVES_INVALIDAS)
def test_clave_invalida_la_rechazan_todos_los_metodos(storage, tmp_path, clave):
    with pytest.raises(InvalidKey):
        storage.stat(clave)
    with pytest.raises(InvalidKey):
        list(storage.open_range(clave))
    with pytest.raises(InvalidKey):
        storage.delete(clave)
    with pytest.raises(InvalidKey):
        storage.put_file(clave, _origen(tmp_path, b"x"))


def test_validate_key_devuelve_la_clave_tal_cual():
    assert validate_key("Beyoncé/Beyoncé - Halo.mp3") == "Beyoncé/Beyoncé - Halo.mp3"
    assert validate_key("a/b/c.mp3") == "a/b/c.mp3"


# --------------------------------------------------------------- put/stat/list
def test_put_luego_stat_y_list(storage, adapter_name, tmp_path):
    data = b"0123456789"
    key = _poner(storage, tmp_path, "Artista/Artista - Tema.mp3", data)

    f = storage.stat(key)
    assert isinstance(f, StoredFile)
    assert f.key == key
    assert f.size == len(data)
    assert f.mtime > 0
    if adapter_name == "local":
        assert f.etag is None  # el disco no tiene revision de proveedor
    else:
        assert f.etag  # la nube trae la revision (version) del proveedor

    listado = list(storage.list())
    assert [x.key for x in listado] == [key]
    assert listado[0].size == len(data)


def test_put_file_mueve_el_origen(storage, tmp_path):
    src = _origen(tmp_path, b"abc")
    storage.put_file("A/A - x.mp3", src)
    assert not src.exists(), "put_file tiene que MOVER, no copiar"


def test_put_sobreescribe_la_misma_clave(storage, tmp_path):
    key = _poner(storage, tmp_path, "A/A - x.mp3", b"aaaa")
    _poner(storage, tmp_path, key, b"bb")

    assert storage.stat(key).size == 2
    assert len(list(storage.list())) == 1


def test_list_ignora_lo_que_no_es_audio(storage, tmp_path):
    _poner(storage, tmp_path, "A/cancion.mp3", b"x")
    _poner(storage, tmp_path, "A/notas.txt", b"x")
    assert [f.key for f in storage.list()] == ["A/cancion.mp3"]


def test_list_ignora_ocultos(storage, tmp_path):
    _poner(storage, tmp_path, "A/cancion.mp3", b"x")
    _poner(storage, tmp_path, "A/.oculto.mp3", b"x")
    _poner(storage, tmp_path, ".carpeta/otra.mp3", b"x")
    assert [f.key for f in storage.list()] == ["A/cancion.mp3"]


def test_list_usa_extension_sin_importar_mayusculas(storage, tmp_path):
    _poner(storage, tmp_path, "A/mayus.MP3", b"x")
    assert [f.key for f in storage.list()] == ["A/mayus.MP3"]


# ------------------------------------------------- media nueva: video y jpg
def test_list_incluye_video_y_miniaturas(storage, tmp_path):
    """`list()` suma video (.mp4/.webm/.mkv) y el sidecar `.jpg`; el resto no."""
    for key in ("A/tema.mp3", "A/clip.mp4", "A/clip.jpg", "A/otro.webm",
                "A/matroska.mkv", "A/notas.txt"):
        _poner(storage, tmp_path, key, b"x")
    assert sorted(f.key for f in storage.list()) == [
        "A/clip.jpg", "A/clip.mp4", "A/matroska.mkv", "A/otro.webm",
        "A/tema.mp3"]


@pytest.mark.parametrize("ext", [".mp4", ".webm", ".mkv", ".jpg"])
def test_video_y_miniatura_round_trip(storage, tmp_path, ext):
    """put -> stat -> open_range (con rango) sobre las extensiones nuevas."""
    data = bytes(range(256)) * 3  # 768 bytes
    key = f"A/A - Clip{ext}"
    _poner(storage, tmp_path, key, data)

    assert storage.stat(key).size == len(data)
    assert b"".join(storage.open_range(key)) == data
    assert b"".join(storage.open_range(key, 10, 20)) == data[10:21]
    assert [f.key for f in storage.list()] == [key]


# ------------------------------------------------------------------ open_range
def test_open_range_completo(storage, tmp_path):
    data = bytes(range(256)) * 4  # 1 KiB
    key = _poner(storage, tmp_path, "A/x.mp3", data)
    assert b"".join(storage.open_range(key)) == data


def test_open_range_es_inclusivo(storage, tmp_path):
    data = b"0123456789"
    key = _poner(storage, tmp_path, "A/x.mp3", data)
    assert b"".join(storage.open_range(key, 2, 5)) == b"2345"


def test_open_range_solo_inicio(storage, tmp_path):
    data = b"0123456789"
    key = _poner(storage, tmp_path, "A/x.mp3", data)
    assert b"".join(storage.open_range(key, 2)) == b"23456789"


def test_open_range_end_mas_alla_del_tamano(storage, tmp_path):
    data = b"0123456789"
    key = _poner(storage, tmp_path, "A/x.mp3", data)
    assert b"".join(storage.open_range(key, 5, 100)) == b"56789"


def test_open_range_vacio(storage, tmp_path):
    data = b"0123456789"
    key = _poner(storage, tmp_path, "A/x.mp3", data)
    # end < start no devuelve nada
    assert b"".join(storage.open_range(key, 5, 4)) == b""
    # arrancar en el final tampoco
    assert b"".join(storage.open_range(key, len(data))) == b""


def test_open_range_cruza_varios_chunks(storage, tmp_path):
    """Un archivo mas grande que CHUNK (64 KiB) se lee entero y en orden."""
    data = bytes(range(256)) * 1024  # 256 KiB
    key = _poner(storage, tmp_path, "A/grande.mp3", data)
    assert b"".join(storage.open_range(key)) == data
    assert b"".join(storage.open_range(key, 100, 70000)) == data[100:70001]


# ------------------------------------------------------------------- errores
def test_clave_inexistente_da_filenotfound(storage):
    for llamada in (
        lambda: storage.stat("A/no-existe.mp3"),
        lambda: list(storage.open_range("A/no-existe.mp3")),
        lambda: storage.delete("A/no-existe.mp3"),
    ):
        with pytest.raises(FileNotFoundError):
            llamada()


def test_delete_luego_filenotfound(storage, tmp_path):
    key = _poner(storage, tmp_path, "A/A - x.mp3", b"x")
    storage.delete(key)
    with pytest.raises(FileNotFoundError):
        storage.stat(key)
    with pytest.raises(FileNotFoundError):
        storage.delete(key)
    assert list(storage.list()) == []


# ------------------------------------------------------------------- unicode
def test_claves_unicode(storage, tmp_path):
    key = "Beyoncé/Beyoncé - Halo.mp3"
    data = b"\xff\xfb\x90\x00" + b"\x00" * 16
    f = storage.put_file(key, _origen(tmp_path, data))

    assert f.key == key
    assert storage.stat(key).size == len(data)
    assert [x.key for x in storage.list()] == [key]
    assert b"".join(storage.open_range(key)) == data


# ------------------------------------------------------------------- symlinks
def test_un_symlink_que_escapa_de_la_raiz_no_se_sirve(tmp_path):
    """Un enlace dentro de la biblioteca no puede exponer archivos de afuera."""
    fuera = tmp_path / "fuera"
    fuera.mkdir()
    (fuera / "secreto.mp3").write_bytes(b"secreto")

    root = tmp_path / "root"
    root.mkdir()
    enlace = root / "atajo"
    try:
        enlace.symlink_to(fuera, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("no se pueden crear symlinks (privilegios en Windows)")

    storage = LocalStorage(root)
    with pytest.raises(InvalidKey):
        storage.stat("atajo/secreto.mp3")
    with pytest.raises(InvalidKey):
        list(storage.open_range("atajo/secreto.mp3"))
    # `list()` tampoco lo publica: recorre pero no sigue el enlace hacia afuera
    assert [f.key for f in storage.list()] == []


def test_describe_es_la_etiqueta_de_la_raiz(tmp_path):
    root = tmp_path / "root"
    storage = LocalStorage(root)
    assert storage.describe() == str(root)


@pytest.mark.skipif(os.name == "nt", reason="Windows no deja crear un archivo con '?'")
def test_list_no_publica_nombres_que_no_son_claves_validas(tmp_path):
    """En Linux/Android un archivo puede llevar '?': no se lista, daria 404."""
    root = tmp_path / "root"
    (root / "A").mkdir(parents=True)
    (root / "A" / "que?.mp3").write_bytes(b"x")
    (root / "A" / "bien.mp3").write_bytes(b"x")
    assert [f.key for f in LocalStorage(root).list()] == ["A/bien.mp3"]


def test_stat_no_lee_la_duracion(storage, tmp_path):
    """stat corre en cada seek de /api/audio: no puede parsear el archivo."""
    key = _poner(storage, tmp_path, "A/A - T.mp3", b"no es un mp3 real")
    assert storage.stat(key).duration is None


# ------------------------------------------------------------------ etiquetas
def _mp3_etiquetado(mp3: Path, dest: Path, **tags: str) -> Path:
    """Copia del MP3 sintetico con etiquetas ID3 escritas por mutagen."""
    from mutagen.easyid3 import EasyID3
    from mutagen.id3 import ID3NoHeaderError

    dest.write_bytes(mp3.read_bytes())
    try:
        audio = EasyID3(str(dest))
    except ID3NoHeaderError:
        audio = EasyID3()
    for k, v in tags.items():
        audio[k] = v
    audio.save(str(dest))
    return dest


def test_list_trae_titulo_artista_y_album(storage, tmp_path, mp3_desde_wav):
    """Escuchar agrupa por artista y album: `list()` trae las etiquetas.

    En disco salen de la misma lectura de mutagen que la duracion; en la nube,
    del indice que se escribio al subir el archivo.
    """
    src = _mp3_etiquetado(mp3_desde_wav, tmp_path / "origen-tags.mp3",
                          title="Canción", artist="Ñandú", album="Primero")
    storage.put_file("Ñandú/Ñandú - Canción.mp3", src)

    (f,) = list(storage.list())
    assert (f.title, f.artist, f.album) == ("Canción", "Ñandú", "Primero")
    assert f.duration and f.duration > 2


def test_list_sin_etiquetas_las_deja_vacias(storage, tmp_path, mp3_desde_wav):
    """Un archivo sin etiquetas no inventa nada: la UI cae al nombre."""
    from mutagen.id3 import ID3NoHeaderError, delete

    src = tmp_path / "origen-sin-tags.mp3"
    src.write_bytes(mp3_desde_wav.read_bytes())
    # El MP3 de la sesion es compartido y otros tests le escriben etiquetas.
    try:
        delete(str(src))
    except ID3NoHeaderError:
        pass
    storage.put_file("A/A - T.mp3", src)

    (f,) = list(storage.list())
    assert not f.title and not f.artist and not f.album
