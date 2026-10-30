"""Actualizador automatico de yt-dlp: descarga, verificacion y carga.

Todo OFFLINE. `check_and_update` recibe un `httpx.Client`; los tests le pasan uno
con `httpx.MockTransport`, asi que GitHub nunca se toca. El `MockTransport`
imita lo que hace github.com sin API: `/releases/latest` contesta 302 con el tag
en el `Location` y despues se bajan las tres URLs directas (sumas, firma y
zipapp). El zipapp falso es un zip real (con shebang) para que `zipfile` y
`zipimport` lo acepten igual que al oficial.

La verificacion de la firma tiene su propio archivo, `test_ytdlp_signature.py`,
con el vector real. Aca el zipapp de mentira NO lo puede firmar yt-dlp, asi que
un fixture autouse reemplaza `ytdlp_signature.verify_detached` por un no-op y lo
que se testea es que el updater la LLAME en el orden correcto y que se comporte
bien cuando falla. El unico test que usa la verificacion de verdad es
`test_firma_real_*`, que sirve el `SHA2-256SUMS` y el `.sig` reales (por eso
tiene que cortar despues, en el checksum del zip).

Cubre:
- instalacion de una version nueva + `current.json`;
- version igual o mas vieja => no baja;
- checksum que no coincide y archivo que no es zip => no se instala nada;
- firma invalida y firma faltante => no se instala nada;
- firma real + sumas reales => pasa la firma y corta en el checksum del zip;
- el tag sale del `Location`: sin `/tag/`, sin redirect o con un tag que no es
  numerico => no se instala nada y no se baja nada;
- throttle de 24 h y actualizacion de `checked_at` cuando no hay novedades;
- deshabilitado por env y carpeta de usuario sin manifest;
- poda: quedan solo el zip actual y el anterior;
- error de red => None;
- `runtime.setup_ytdlp_dir` cargando el zip del manifest (y fallback si el hash
  o el archivo no sirven), sin bajar nunca por debajo del yt-dlp empaquetado;
- el zip no se importa al arrancar: `runtime.verify_ytdlp_zip` lo prueba
  despues, en un thread, y descarta uno que no importa;
- el zip que importa se extrae a `yt-dlp-<version>/` con lo importado ya
  compilado, el arranque siguiente usa esa carpeta, y una carpeta rota, de
  otro zip o a medio extraer hace volver al zip;
- `runtime.bundled_ytdlp_version` leyendo un paquete de `sys.path`.
"""
from __future__ import annotations

import hashlib
import importlib
import importlib.util
import io
import json
import logging
import os
import sys
import threading
import time
import zipfile
from pathlib import Path

import httpx
import pytest

from backend.app import runtime
from backend.app import ytdlp_signature
from backend.app import ytdlp_update as ytup

#: Version que los tests dicen que esta cargada (asi no dependen del instalado).
CARGADA = "2026.01.01"
#: Verificacion de firmas de verdad; el fixture autouse la pisa por un no-op.
FIRMA_REAL = ytdlp_signature.verify_detached
#: Vector real del release 2026.08.19, el mismo que usa test_ytdlp_signature.py.
VECTOR = Path(__file__).parent / "data" / "ytdlp" / "2026.08.19"
#: Tag de ese vector: mas nuevo que CARGADA, asi el updater intenta instalarlo.
TAG_REAL = "2026.08.19"


# --------------------------------------------------------------------- helpers
def _zipapp(version: str) -> bytes:
    """Zipapp falso: zip con shebang, `yt_dlp/__init__.py` y `version.py`.

    Como el oficial, trae `__main__.py` y un segundo paquete (`yt_dlp_ejs/`).
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("__main__.py", "import yt_dlp\n")
        z.writestr("yt_dlp/__init__.py", "")
        z.writestr("yt_dlp/version.py", f"__version__ = {version!r}\n")
        z.writestr("yt_dlp_ejs/__init__.py", "")
    return b"#!/usr/bin/env python3\n" + buf.getvalue()


def _manifest(version=None, archivo=None, sha=None, checked_at=0) -> str:
    return json.dumps({"version": version, "file": archivo, "sha256": sha,
                       "checked_at": checked_at})


def _github(version, zipapp=None, *, sums=None, firma=None, registro=None,
            zip_status=200, sums_status=200, firma_status=200, tag_status=302,
            location=None):
    """`MockTransport` que imita los redirects de github.com (sin API).

    `/releases/latest` contesta 302 con el tag en el `Location`; con
    `location=` se fuerza otro valor y con `tag_status=` otra respuesta. Los
    assets son tres: sumas, firma y zipapp; con los `*_status` se simula que
    alguno no esta (404, por ejemplo).
    """
    cuerpo = zipapp if zipapp is not None else _zipapp("2099.1.1")
    suma = sums if sums is not None else f"{hashlib.sha256(cuerpo).hexdigest()}  yt-dlp\n"
    # El verificador mira bytes exactos: si `sums` ya viene en bytes, se sirve tal cual.
    datos_suma = suma if isinstance(suma, bytes) else suma.encode("utf-8")
    sig = firma if firma is not None else b"firma-de-mentira"

    def handler(request: httpx.Request) -> httpx.Response:
        if registro is not None:
            registro.append(request.url.path)
        ruta = request.url.path
        if ruta.endswith("/releases/latest"):
            if tag_status != 302:
                return httpx.Response(tag_status)
            destino = location or f"/yt-dlp/yt-dlp/releases/tag/{version}"
            return httpx.Response(302, headers={"location": destino})
        if ruta.endswith("SHA2-256SUMS.sig"):
            if firma_status != 200:
                return httpx.Response(firma_status)
            return httpx.Response(200, content=sig)
        if ruta.endswith("SHA2-256SUMS"):
            if sums_status != 200:
                return httpx.Response(sums_status)
            return httpx.Response(200, content=datos_suma)
        if ruta.endswith("yt-dlp"):
            return httpx.Response(zip_status, content=cuerpo)
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def _correr(transport) -> str | None:
    with httpx.Client(transport=transport) as client:
        return ytup.check_and_update(client)


def _zips(directorio: Path) -> list[str]:
    return sorted(p.name for p in directorio.glob("yt-dlp-*.zip"))


@pytest.fixture
def cargada(monkeypatch):
    """Fija `runtime.ytdlp_version()` a un valor conocido."""
    monkeypatch.setattr(runtime, "ytdlp_version", lambda: CARGADA)
    return CARGADA


@pytest.fixture
def update_dir(tmp_path, monkeypatch):
    """Directorio de actualizacion gestionado (con manifest) y autoupdate on."""
    d = tmp_path / "ytdlp"
    d.mkdir()
    (d / "current.json").write_text(_manifest(), encoding="utf-8")
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    monkeypatch.setenv("SPITIFO_YTDLP_AUTOUPDATE", "1")
    return d


@pytest.fixture(autouse=True)
def firma_noop(monkeypatch):
    """Neutraliza la verificacion de firmas salvo que el test pida la real.

    Los zipapp de mentira no los firma yt-dlp, asi que sin esto ningun test de
    instalacion llegaria al final. Lo que queda testeado igual es que el updater
    llame al verificador y que no instale nada cuando este falla. Los tests que
    si necesitan la verificacion de verdad la vuelven a poner con `FIRMA_REAL`.
    """
    monkeypatch.setattr(ytup.ytdlp_signature, "verify_detached",
                        lambda data, signature: None)


# ------------------------------------------------------- instalacion / version
def test_version_nueva_instala_y_escribe_manifest(update_dir, cargada):
    nuevo = _zipapp("2099.1.1")
    registro: list[str] = []
    assert _correr(_github("2099.1.1", nuevo, registro=registro)) == "2099.1.1"

    destino = update_dir / "yt-dlp-2099.1.1.zip"
    assert destino.read_bytes() == nuevo
    manifest = json.loads((update_dir / "current.json").read_text("utf-8"))
    assert manifest["version"] == "2099.1.1"
    assert manifest["file"] == destino.name
    assert manifest["sha256"] == hashlib.sha256(nuevo).hexdigest()
    assert manifest["checked_at"] > 1e6
    # no quedan temporales
    assert list(update_dir.glob(".yt-dlp-*")) == []
    assert list(update_dir.glob(".current-*")) == []
    # consulto la release, las sumas, la firma y el zip, en ese orden
    assert len(registro) == 4
    assert registro[0].endswith("/releases/latest")
    assert registro[1].endswith("/releases/download/2099.1.1/SHA2-256SUMS")
    assert registro[2].endswith("/releases/download/2099.1.1/SHA2-256SUMS.sig")
    assert registro[3].endswith("/releases/download/2099.1.1/yt-dlp")


def test_tag_con_v_inicial_se_normaliza(update_dir, cargada):
    assert _correr(_github("v2099.1.1")) == "2099.1.1"


@pytest.mark.parametrize("tag", [CARGADA, "2020.1.1", "2025.12.31"])
def test_misma_o_mas_vieja_no_baja(update_dir, cargada, tag):
    registro: list[str] = []
    assert _correr(_github(tag, registro=registro)) is None
    assert _zips(update_dir) == []
    # el chequeo igual quedo registrado
    manifest = json.loads((update_dir / "current.json").read_text("utf-8"))
    assert manifest["checked_at"] > 1e6


def test_version_ya_pendiente_no_se_rebaja(update_dir, cargada):
    zipapp = _zipapp("2099.1.1")
    sha = hashlib.sha256(zipapp).hexdigest()
    (update_dir / "yt-dlp-2099.1.1.zip").write_bytes(zipapp)
    (update_dir / "current.json").write_text(
        _manifest("2099.1.1", "yt-dlp-2099.1.1.zip", sha), encoding="utf-8")
    registro: list[str] = []
    assert _correr(_github("2099.1.1", registro=registro)) is None
    # consulto la release pero NO bajo nada de nuevo
    assert len(registro) == 1
    assert registro[0].endswith("/releases/latest")
    assert _zips(update_dir) == ["yt-dlp-2099.1.1.zip"]


# ------------------------------------------------------------------ verificacion
def test_checksum_no_coincide_no_instala(update_dir, cargada):
    nuevo = _zipapp("2099.1.1")
    basura = "0" * 64
    assert _correr(_github("2099.1.1", nuevo, sums=f"{basura}  yt-dlp\n")) is None
    assert _zips(update_dir) == []
    # el manifest queda como estaba (checked_at 0)
    assert json.loads((update_dir / "current.json").read_text("utf-8"))["checked_at"] == 0
    assert list(update_dir.glob(".yt-dlp-*")) == []


def test_no_es_zip_no_instala(update_dir, cargada):
    assert _correr(_github("2099.1.1", b"no soy un zip")) is None
    assert _zips(update_dir) == []


def test_verifica_las_sumas_antes_de_creerles(update_dir, cargada, monkeypatch):
    """El verificador recibe los bytes EXACTOS de las sumas y de la firma."""
    visto: list[tuple[bytes, bytes]] = []

    def _espia(data, signature):
        visto.append((data, signature))

    monkeypatch.setattr(ytup.ytdlp_signature, "verify_detached", _espia)
    suma = f"{hashlib.sha256(_zipapp('2099.1.1')).hexdigest()}  yt-dlp\n".encode()
    assert _correr(_github("2099.1.1", sums=suma, firma=b"firma-x")) == "2099.1.1"
    assert visto == [(suma, b"firma-x")]


def test_firma_invalida_no_instala(update_dir, cargada, monkeypatch, caplog):
    """Si la firma no valida, no se baja el zip ni se toca el manifest."""
    def _rechaza(data, signature):
        raise ytdlp_signature.SignatureError("firma rota")

    monkeypatch.setattr(ytup.ytdlp_signature, "verify_detached", _rechaza)
    registro: list[str] = []
    with caplog.at_level(logging.WARNING, logger="spitifo.ytdlp_update"):
        assert _correr(_github("2099.1.1", registro=registro)) is None

    assert _zips(update_dir) == []
    assert list(update_dir.glob(".yt-dlp-*")) == []
    manifest = json.loads((update_dir / "current.json").read_text("utf-8"))
    assert manifest["checked_at"] == 0
    # corto en la firma: nunca pidio el zip
    assert len(registro) == 3
    assert registro[2].endswith("/releases/download/2099.1.1/SHA2-256SUMS.sig")
    assert "firma invalida" in caplog.text


def test_firma_faltante_no_instala(update_dir, cargada, caplog):
    """Una release sin `.sig` (404) no se instala: sin firma no hay confianza."""
    registro: list[str] = []
    with caplog.at_level(logging.WARNING, logger="spitifo.ytdlp_update"):
        assert _correr(_github("2099.1.1", registro=registro,
                               firma_status=404)) is None

    assert _zips(update_dir) == []
    assert len(registro) == 3
    assert registro[2].endswith("SHA2-256SUMS.sig")
    assert "SHA2-256SUMS.sig" in caplog.text
    manifest = json.loads((update_dir / "current.json").read_text("utf-8"))
    assert manifest["checked_at"] == 0


def test_sumas_faltantes_no_instala(update_dir, cargada):
    """Sin sumas no hay nada que verificar ni que comparar."""
    assert _correr(_github("2099.1.1", sums_status=404)) is None
    assert _zips(update_dir) == []


def test_firma_real_pasa_y_corta_en_el_checksum_del_zip(update_dir, cargada,
                                                        monkeypatch, caplog):
    """Con el vector REAL: la firma valida y el que rechaza es el SHA-256.

    Las sumas reales describen los archivos reales del release, que no tenemos
    (ni podemos fabricar: seria una preimagen de SHA-256). Asi que el zip que se
    sirve es un zipapp valido cualquiera: tiene que fallar en el checksum, y eso
    es justamente la prueba de que la firma paso antes.
    """
    monkeypatch.setattr(ytup.ytdlp_signature, "verify_detached", FIRMA_REAL)
    sumas = (VECTOR / "SHA2-256SUMS").read_bytes()
    firma = (VECTOR / "SHA2-256SUMS.sig").read_bytes()
    registro: list[str] = []
    transport = _github(TAG_REAL, _zipapp("2099.1.1"), sums=sumas, firma=firma,
                        registro=registro)

    with caplog.at_level(logging.WARNING, logger="spitifo.ytdlp_update"):
        assert _correr(transport) is None

    assert _zips(update_dir) == []
    assert registro[1].endswith(f"/{TAG_REAL}/SHA2-256SUMS")
    assert registro[2].endswith(f"/{TAG_REAL}/SHA2-256SUMS.sig")
    # llego hasta el zip: la firma paso, corto el checksum
    assert registro[3].endswith(f"/{TAG_REAL}/yt-dlp")
    assert "SHA-256" in caplog.text
    assert "firma invalida" not in caplog.text


def test_firma_real_sobre_sumas_tocadas_falla(update_dir, cargada, monkeypatch):
    """El vector real deja de pasar si se toca una sola linea de las sumas."""
    monkeypatch.setattr(ytup.ytdlp_signature, "verify_detached", FIRMA_REAL)
    sumas = (VECTOR / "SHA2-256SUMS").read_bytes().replace(b"  yt-dlp\n",
                                                           b"  yt-dlp \n")
    firma = (VECTOR / "SHA2-256SUMS.sig").read_bytes()
    assert _correr(_github(TAG_REAL, sums=sumas, firma=firma)) is None
    assert _zips(update_dir) == []


def test_location_sin_tag_no_instala(update_dir, cargada):
    registro: list[str] = []
    transport = _github("2099.1.1", registro=registro,
                        location="https://github.com/yt-dlp/yt-dlp/releases")
    assert _correr(transport) is None
    # consulto solo la release: no bajo nada
    assert registro == ["/yt-dlp/yt-dlp/releases/latest"]
    assert _zips(update_dir) == []


def test_respuesta_que_no_es_redirect_no_instala(update_dir, cargada):
    registro: list[str] = []
    assert _correr(_github("2099.1.1", registro=registro, tag_status=200)) is None
    assert len(registro) == 1
    assert _zips(update_dir) == []


def test_tag_no_numerico_en_location_no_instala(update_dir, cargada):
    assert _correr(_github("no-es-una-version")) is None
    assert _zips(update_dir) == []


def test_sums_sin_la_linea_de_yt_dlp_no_instala(update_dir, cargada):
    assert _correr(_github("2099.1.1", sums="deadbeef  otro\n")) is None
    assert _zips(update_dir) == []


def test_error_de_red_devuelve_none(update_dir, cargada):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("sin red")

    assert _correr(httpx.MockTransport(handler)) is None


# ----------------------------------------------------------------------- limites
def test_throttle_24h_no_consulta(update_dir, cargada):
    (update_dir / "current.json").write_text(
        _manifest(checked_at=time.time()), encoding="utf-8")
    registro: list[str] = []
    assert _correr(_github("2099.1.1", registro=registro)) is None
    assert registro == []


def test_deshabilitado_por_env(update_dir, cargada, monkeypatch):
    monkeypatch.setenv("SPITIFO_YTDLP_AUTOUPDATE", "0")
    registro: list[str] = []
    assert _correr(_github("2099.1.1", registro=registro)) is None
    assert registro == []


@pytest.mark.parametrize("valor", ["false", "no", "FALSE", "No"])
def test_deshabilitado_por_env_variantes(update_dir, cargada, monkeypatch, valor):
    monkeypatch.setenv("SPITIFO_YTDLP_AUTOUPDATE", valor)
    registro: list[str] = []
    assert _correr(_github("2099.1.1", registro=registro)) is None
    assert registro == []


def test_carpeta_de_usuario_sin_manifest_no_se_toca(tmp_path, cargada, monkeypatch):
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(tmp_path))
    monkeypatch.setenv("SPITIFO_YTDLP_AUTOUPDATE", "1")
    registro: list[str] = []
    assert _correr(_github("2099.1.1", registro=registro)) is None
    assert registro == []
    assert not (tmp_path / "current.json").exists()


def test_poda_deja_dos_zips(update_dir, cargada):
    for nombre, mtime in (("yt-dlp-2020.1.1.zip", 1_000),
                          ("yt-dlp-2020.1.2.zip", 2_000)):
        archivo = update_dir / nombre
        archivo.write_bytes(b"viejo")
        os.utime(archivo, (mtime, mtime))
    assert _correr(_github("2099.1.1")) == "2099.1.1"
    # queda el nuevo y el anterior inmediato
    assert _zips(update_dir) == ["yt-dlp-2020.1.2.zip", "yt-dlp-2099.1.1.zip"]


# --------------------------------------------------------------- pending/health
def test_pending_version(update_dir, cargada):
    assert ytup.pending_version() is None
    (update_dir / "current.json").write_text(
        _manifest("2099.1.1", "yt-dlp-2099.1.1.zip", "a" * 64),
        encoding="utf-8")
    assert ytup.pending_version() == "2099.1.1"


def test_pending_version_none_si_es_la_cargada(update_dir, cargada):
    (update_dir / "current.json").write_text(
        _manifest(CARGADA, "yt-dlp-2026.01.01.zip", "a" * 64),
        encoding="utf-8")
    assert ytup.pending_version() is None


def test_start_background_check_corre(monkeypatch):
    llamado = threading.Event()
    monkeypatch.setattr(ytup, "check_and_update",
                        lambda client=None: llamado.set() or None)
    hilo = ytup.start_background_check(delay=0.05)
    assert hilo.daemon
    assert llamado.wait(3), "el thread de fondo no corrio"


def test_health_informa_ytdlp_pending(cliente):
    body = cliente.get("/api/health").json()
    assert "ytdlp_pending" in body
    assert body["ytdlp_pending"] is None or isinstance(body["ytdlp_pending"], str)


# --------------------------------------------- carga del zip desde el manifest
@pytest.fixture
def sistema_limpio():
    """Deja `sys.path`/`sys.modules` como estaban: importar yt_dlp es global."""
    path_previo = list(sys.path)
    pendiente_previo = runtime._zip_pendiente
    por_extraer_previo = runtime._por_extraer
    mods = {k: v for k, v in sys.modules.items()
            if k == "yt_dlp" or k.startswith("yt_dlp.")}
    for k in mods:
        del sys.modules[k]
    yield
    sys.path[:] = path_previo
    runtime._zip_pendiente = pendiente_previo
    runtime._por_extraer = por_extraer_previo
    for k in list(sys.modules):
        if k == "yt_dlp" or k.startswith("yt_dlp."):
            del sys.modules[k]
    sys.modules.update(mods)


def _dir_con_manifest(tmp_path: Path, *, sha_ok: bool,
                      archivo: str | None = None) -> tuple[Path, Path]:
    d = tmp_path / "ytdlp"
    d.mkdir()
    zipapp = _zipapp("2099.1.1")
    real = d / "yt-dlp-2099.1.1.zip"
    real.write_bytes(zipapp)
    sha = hashlib.sha256(zipapp).hexdigest() if sha_ok else "b" * 64
    (d / "current.json").write_text(
        _manifest("2099.1.1", archivo or real.name, sha), encoding="utf-8")
    return d, real


def test_setup_ytdlp_dir_carga_el_zip_del_manifest(tmp_path, monkeypatch,
                                                   sistema_limpio):
    d, real = _dir_con_manifest(tmp_path, sha_ok=True)
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    assert runtime.setup_ytdlp_dir() is True
    assert sys.path[0] == str(real)

    version = importlib.import_module("yt_dlp.version")
    assert version.__version__ == "2099.1.1"


# ------------------------- el zip se prueba despues del arranque, no durante
def _zip_roto(d: Path) -> Path:
    """Zipapp con un `yt_dlp/__init__.py` que falla al importarse."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("yt_dlp/__init__.py", "raise ImportError('roto')\n")
        z.writestr("yt_dlp/version.py", "__version__ = '2099.1.1'\n")
    zipapp = b"#!/usr/bin/env python3\n" + buf.getvalue()
    real = d / "yt-dlp-2099.1.1.zip"
    real.write_bytes(zipapp)
    (d / "current.json").write_text(
        _manifest("2099.1.1", real.name, hashlib.sha256(zipapp).hexdigest()),
        encoding="utf-8")
    return real


def test_setup_ytdlp_dir_no_importa_el_zip(tmp_path, monkeypatch,
                                           sistema_limpio):
    d, real = _dir_con_manifest(tmp_path, sha_ok=True)
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    assert runtime.setup_ytdlp_dir() is True
    assert "yt_dlp" not in sys.modules
    assert runtime._zip_pendiente == str(real)


def test_verify_ytdlp_zip_importa_el_zip_bueno(tmp_path, monkeypatch,
                                               sistema_limpio):
    d, real = _dir_con_manifest(tmp_path, sha_ok=True)
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    runtime.setup_ytdlp_dir()

    assert runtime.verify_ytdlp_zip() is True
    assert sys.modules["yt_dlp"].__file__.startswith(str(real))
    assert sys.path[0] == str(real)
    # Ya probado: una segunda llamada no tiene nada que hacer.
    assert runtime.verify_ytdlp_zip() is None


def test_verify_ytdlp_zip_descarta_el_zip_roto(tmp_path, monkeypatch,
                                               sistema_limpio, caplog):
    d = tmp_path / "ytdlp"
    d.mkdir()
    real = _zip_roto(d)
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    assert runtime.setup_ytdlp_dir() is True
    assert sys.path[0] == str(real)

    with caplog.at_level(logging.WARNING, logger="spitifo.runtime"):
        assert runtime.verify_ytdlp_zip() is False
    assert str(real) not in sys.path
    assert not [m for m in sys.modules
                if m == "yt_dlp" or m.startswith("yt_dlp.")]
    assert "no se puede importar" in caplog.text


def test_verify_ytdlp_zip_sin_zip_no_hace_nada(sistema_limpio):
    runtime._zip_pendiente = None
    assert runtime.verify_ytdlp_zip() is None
    assert runtime.start_ytdlp_zip_check() is None


def test_start_ytdlp_zip_check_prueba_en_un_thread(tmp_path, monkeypatch,
                                                   sistema_limpio):
    d, real = _dir_con_manifest(tmp_path, sha_ok=True)
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    runtime.setup_ytdlp_dir()

    hilo = runtime.start_ytdlp_zip_check()
    assert hilo is not None and hilo.daemon
    hilo.join(5)
    assert not hilo.is_alive()
    assert runtime._zip_pendiente is None
    assert sys.modules["yt_dlp"].__file__.startswith(str(real))


# ------------------- el zip que importa se extrae para el arranque siguiente
def _otro_arranque(path_previo: list[str]) -> None:
    """Simula un arranque nuevo: sin yt_dlp cargado ni la ruta insertada."""
    sys.path[:] = path_previo
    for k in [m for m in sys.modules
              if m == "yt_dlp" or m.startswith("yt_dlp.")]:
        del sys.modules[k]
    runtime._zip_pendiente = None
    runtime._por_extraer = None
    importlib.invalidate_caches()


def test_verify_extrae_y_compila_solo_lo_importado(tmp_path, monkeypatch,
                                                   sistema_limpio):
    d, real = _dir_con_manifest(tmp_path, sha_ok=True)
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    runtime.setup_ytdlp_dir()
    assert runtime.verify_ytdlp_zip() is True

    carpeta = d / "yt-dlp-2099.1.1"
    assert (carpeta / runtime._MARCA_EXTRAIDA).read_text(encoding="utf-8") \
        == hashlib.sha256(real.read_bytes()).hexdigest()
    init = carpeta / "yt_dlp" / "__init__.py"
    version = carpeta / "yt_dlp" / "version.py"
    assert Path(importlib.util.cache_from_source(str(init))).is_file()
    # `version.py` no se importo durante la prueba: queda sin compilar.
    assert version.is_file()
    assert not Path(importlib.util.cache_from_source(str(version))).exists()
    # Todos los paquetes del zip, pero no el `__main__.py` del zipapp.
    assert (carpeta / "yt_dlp_ejs" / "__init__.py").is_file()
    assert not (carpeta / "__main__.py").exists()


def test_el_arranque_siguiente_usa_la_carpeta(tmp_path, monkeypatch,
                                              sistema_limpio):
    previo = list(sys.path)
    d, real = _dir_con_manifest(tmp_path, sha_ok=True)
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    runtime.setup_ytdlp_dir()
    runtime.verify_ytdlp_zip()

    _otro_arranque(previo)
    assert runtime.setup_ytdlp_dir() is True
    carpeta = d / "yt-dlp-2099.1.1"
    assert sys.path[0] == str(carpeta)
    assert runtime._por_extraer is None
    assert runtime.verify_ytdlp_zip() is True
    assert sys.modules["yt_dlp"].__file__.startswith(str(carpeta))
    assert importlib.import_module("yt_dlp.version").__version__ == "2099.1.1"


def test_carpeta_de_otro_zip_no_se_usa(tmp_path, monkeypatch, sistema_limpio):
    d, real = _dir_con_manifest(tmp_path, sha_ok=True)
    carpeta = d / "yt-dlp-2099.1.1"
    (carpeta / "yt_dlp").mkdir(parents=True)
    (carpeta / "yt_dlp" / "__init__.py").write_text("", encoding="utf-8")
    (carpeta / runtime._MARCA_EXTRAIDA).write_text("c" * 64, encoding="utf-8")
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    assert runtime.setup_ytdlp_dir() is True
    assert sys.path[0] == str(real)


def test_carpeta_rota_se_borra_y_se_vuelve_al_zip(tmp_path, monkeypatch,
                                                  sistema_limpio, caplog):
    previo = list(sys.path)
    d, real = _dir_con_manifest(tmp_path, sha_ok=True)
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    runtime.setup_ytdlp_dir()
    runtime.verify_ytdlp_zip()
    carpeta = d / "yt-dlp-2099.1.1"
    (carpeta / "yt_dlp" / "__init__.py").write_text(
        "raise ImportError('roto')\n", encoding="utf-8")

    _otro_arranque(previo)
    runtime.setup_ytdlp_dir()
    with caplog.at_level(logging.WARNING, logger="spitifo.runtime"):
        assert runtime.verify_ytdlp_zip() is False
    assert not carpeta.exists()
    assert str(carpeta) not in sys.path

    _otro_arranque(previo)
    assert runtime.setup_ytdlp_dir() is True
    assert sys.path[0] == str(real)


def test_extraer_borra_las_carpetas_viejas(tmp_path, monkeypatch,
                                           sistema_limpio):
    d, real = _dir_con_manifest(tmp_path, sha_ok=True)
    (d / "yt-dlp-2098.1.1" / "yt_dlp").mkdir(parents=True)
    (d / ".extraer-cortada").mkdir()
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    runtime.setup_ytdlp_dir()
    runtime.verify_ytdlp_zip()
    assert sorted(p.name for p in d.iterdir() if p.is_dir()) \
        == ["yt-dlp-2099.1.1"]
    assert real.is_file()


def test_extraccion_fallida_sigue_con_el_zip(tmp_path, monkeypatch,
                                             sistema_limpio, caplog):
    import py_compile

    previo = list(sys.path)
    d, real = _dir_con_manifest(tmp_path, sha_ok=True)
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))

    def compilar_roto(*args, **kwargs):
        raise OSError("disco lleno")

    monkeypatch.setattr(py_compile, "compile", compilar_roto)
    runtime.setup_ytdlp_dir()
    with caplog.at_level(logging.WARNING, logger="spitifo.runtime"):
        assert runtime.verify_ytdlp_zip() is True
    assert "no se pudo extraer" in caplog.text
    assert not (d / "yt-dlp-2099.1.1" / runtime._MARCA_EXTRAIDA).exists()

    _otro_arranque(previo)
    assert runtime.setup_ytdlp_dir() is True
    assert sys.path[0] == str(real)


def test_setup_ytdlp_dir_ignora_hash_corrupto(tmp_path, monkeypatch,
                                              sistema_limpio):
    d, real = _dir_con_manifest(tmp_path, sha_ok=False)
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    # El manifest no sirve: cae al comportamiento de carpeta de siempre.
    assert runtime.setup_ytdlp_dir() is True
    assert sys.path[0] == str(d)
    assert str(real) not in sys.path


def test_setup_ytdlp_dir_ignora_zip_inexistente(tmp_path, monkeypatch,
                                                sistema_limpio):
    d, real = _dir_con_manifest(tmp_path, sha_ok=True)
    real.unlink()
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    assert runtime.setup_ytdlp_dir() is True
    assert sys.path[0] == str(d)
    assert str(real) not in sys.path


def test_setup_ytdlp_dir_sin_manifest_usa_la_carpeta(tmp_path, monkeypatch,
                                                     sistema_limpio):
    (tmp_path / "yt_dlp").mkdir()
    (tmp_path / "yt_dlp" / "__init__.py").write_text("", encoding="utf-8")
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(tmp_path))
    assert runtime.setup_ytdlp_dir() is True
    assert sys.path[0] == str(tmp_path)


# ------------------------------------- nunca por debajo del yt-dlp empaquetado
def test_setup_ytdlp_dir_no_baja_al_empaquetado(tmp_path, monkeypatch,
                                                sistema_limpio):
    d, real = _dir_con_manifest(tmp_path, sha_ok=True)  # manifest 2099.1.1
    monkeypatch.setattr(runtime, "bundled_ytdlp_version", lambda: "9999.1.1")
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    # El empaquetado es mas nuevo: el zip no se inserta, se usa la carpeta.
    assert runtime.setup_ytdlp_dir() is True
    assert sys.path[0] == str(d)
    assert str(real) not in sys.path


def test_setup_ytdlp_dir_usa_el_zip_si_es_mas_nuevo(tmp_path, monkeypatch,
                                                    sistema_limpio):
    d, real = _dir_con_manifest(tmp_path, sha_ok=True)
    monkeypatch.setattr(runtime, "bundled_ytdlp_version", lambda: "2020.1.1")
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    assert runtime.setup_ytdlp_dir() is True
    assert sys.path[0] == str(real)


def test_setup_ytdlp_dir_usa_el_zip_si_no_se_sabe_el_empaquetado(
        tmp_path, monkeypatch, sistema_limpio):
    d, real = _dir_con_manifest(tmp_path, sha_ok=True)
    monkeypatch.setattr(runtime, "bundled_ytdlp_version", lambda: None)
    monkeypatch.setenv("SPITIFO_YTDLP_DIR", str(d))
    assert runtime.setup_ytdlp_dir() is True
    assert sys.path[0] == str(real)


def test_bundled_ytdlp_version_lee_un_paquete_de_sys_path(tmp_path,
                                                          sistema_limpio):
    fake = tmp_path / "fake"
    pkg = fake / "yt_dlp"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "version.py").write_text("__version__ = '7.7.7'\n", encoding="utf-8")
    sys.path.insert(0, str(fake))
    importlib.invalidate_caches()
    assert runtime.bundled_ytdlp_version() == "7.7.7"
