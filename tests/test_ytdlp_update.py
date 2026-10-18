"""Actualizador automatico de yt-dlp: descarga, verificacion y carga.

Todo OFFLINE. `check_and_update` recibe un `httpx.Client`; los tests le pasan uno
con `httpx.MockTransport`, asi que GitHub nunca se toca. El `MockTransport`
imita lo que hace github.com sin API: `/releases/latest` contesta 302 con el tag
en el `Location` y despues se bajan las dos URLs directas (sumas y zipapp). El
zipapp falso es un zip real (con shebang) para que `zipfile` y `zipimport` lo
acepten igual que al oficial.

Cubre:
- instalacion de una version nueva + `current.json`;
- version igual o mas vieja => no baja;
- checksum que no coincide y archivo que no es zip => no se instala nada;
- el tag sale del `Location`: sin `/tag/`, sin redirect o con un tag que no es
  numerico => no se instala nada y no se baja nada;
- throttle de 24 h y actualizacion de `checked_at` cuando no hay novedades;
- deshabilitado por env y carpeta de usuario sin manifest;
- poda: quedan solo el zip actual y el anterior;
- error de red => None;
- `runtime.setup_ytdlp_dir` cargando el zip del manifest (y fallback si el hash
  o el archivo no sirven), sin bajar nunca por debajo del yt-dlp empaquetado;
- `runtime.bundled_ytdlp_version` leyendo un paquete de `sys.path`.
"""
from __future__ import annotations

import hashlib
import importlib
import io
import json
import os
import sys
import threading
import time
import zipfile
from pathlib import Path

import httpx
import pytest

from backend.app import runtime
from backend.app import ytdlp_update as ytup

#: Version que los tests dicen que esta cargada (asi no dependen del instalado).
CARGADA = "2026.01.01"


# --------------------------------------------------------------------- helpers
def _zipapp(version: str) -> bytes:
    """Zipapp falso: zip con shebang, `yt_dlp/__init__.py` y `version.py`."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("yt_dlp/__init__.py", "")
        z.writestr("yt_dlp/version.py", f"__version__ = {version!r}\n")
    return b"#!/usr/bin/env python3\n" + buf.getvalue()


def _manifest(version=None, archivo=None, sha=None, checked_at=0) -> str:
    return json.dumps({"version": version, "file": archivo, "sha256": sha,
                       "checked_at": checked_at})


def _github(version, zipapp=None, *, sums=None, registro=None,
            zip_status=200, sums_status=200, tag_status=302, location=None):
    """`MockTransport` que imita los redirects de github.com (sin API).

    `/releases/latest` contesta 302 con el tag en el `Location`; con
    `location=` se fuerza otro valor y con `tag_status=` otra respuesta.
    """
    cuerpo = zipapp if zipapp is not None else _zipapp("2099.1.1")
    linea = sums if sums is not None else f"{hashlib.sha256(cuerpo).hexdigest()}  yt-dlp\n"

    def handler(request: httpx.Request) -> httpx.Response:
        if registro is not None:
            registro.append(request.url.path)
        ruta = request.url.path
        if ruta.endswith("/releases/latest"):
            if tag_status != 302:
                return httpx.Response(tag_status)
            destino = location or f"/yt-dlp/yt-dlp/releases/tag/{version}"
            return httpx.Response(302, headers={"location": destino})
        if ruta.endswith("SHA2-256SUMS"):
            if sums_status != 200:
                return httpx.Response(sums_status)
            return httpx.Response(200, text=linea)
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
    # consulto la release, las sumas y el zip, en ese orden
    assert len(registro) == 3
    assert registro[0].endswith("/releases/latest")
    assert registro[1].endswith("/releases/download/2099.1.1/SHA2-256SUMS")
    assert registro[2].endswith("/releases/download/2099.1.1/yt-dlp")


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
    mods = {k: v for k, v in sys.modules.items()
            if k == "yt_dlp" or k.startswith("yt_dlp.")}
    for k in mods:
        del sys.modules[k]
    yield
    sys.path[:] = path_previo
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
