"""Embeber el backend: entry point, secreto por lanzamiento, PATH y MIME.

Todo offline. El middleware se prueba con un `TestClient` en proceso sobre una
app armada a medida (el token entra por parámetro, no por entorno, así que estos
tests no contaminan al resto de la suite). El entry point se prueba con un
subproceso real, que es lo que hace el shell: arrancar, parsear la línea
`SPITIFO_READY` y pegarle al puerto que anuncia.
"""
from __future__ import annotations

import json
import mimetypes
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from backend.app.main import create_app
from backend.app.runtime import (
    AUDIO_MIME_TYPES,
    prepend_to_path,
    register_audio_mime_types,
    setup_ffmpeg_dir,
)
from backend.app.security import COOKIE_NAME, HEADER_NAME

RAIZ = Path(__file__).resolve().parents[1]
SECRETO = "s3cr3t-de-prueba"
READY_PREFIX = "SPITIFO_READY port="


# --------------------------------------------------------------- middleware
# Sin `with`: el TestClient hace requests igual y NO dispara el lifespan, así
# que no toca las fuentes compartidas (que ya cierra la fixture `cliente` de
# conftest). Lo que se prueba acá es el middleware, no el arranque.
@pytest.fixture
def app_con_token():
    return create_app(SECRETO)


@pytest.fixture
def cliente_token(app_con_token):
    return TestClient(app_con_token)


def test_api_sin_credenciales_da_401_json(cliente_token):
    r = cliente_token.get("/api/health")
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/json")
    assert r.json() == {"detail": "unauthorized"}


def test_raiz_sin_credenciales_da_401_texto_plano(cliente_token):
    r = cliente_token.get("/")
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("text/plain")
    assert r.text == "unauthorized"


def test_header_otorga_acceso(cliente_token):
    r = cliente_token.get("/api/health", headers={"X-Spitifo-Token": SECRETO})
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_header_incorrecto_da_401(cliente_token):
    r = cliente_token.get("/api/health", headers={"X-Spitifo-Token": "otro"})
    assert r.status_code == 401


def test_cookie_incorrecta_da_401(cliente_token):
    cliente_token.cookies.set(COOKIE_NAME, "otro")
    r = cliente_token.get("/api/health")
    assert r.status_code == 401


def test_bootstrap_con_token_redirige_y_deja_cookie(
        cliente_token, app_con_token):
    """`/?token=<secreto>`: 303 a la misma ruta sin `token`, con Set-Cookie."""
    r = cliente_token.get(f"/?token={SECRETO}&foo=bar", follow_redirects=False)

    assert r.status_code == 303
    assert r.headers["location"] == "/?foo=bar"

    cookie = r.headers["set-cookie"].lower()
    assert f"{COOKIE_NAME}={SECRETO}".lower() in cookie
    assert "httponly" in cookie
    assert "samesite=strict" in cookie
    assert "path=/" in cookie

    # Y esa cookie, ya en el jar del cliente, abre la API.
    assert cliente_token.get("/api/health").status_code == 200


def test_bootstrap_sin_otros_params_va_a_la_raiz(cliente_token):
    r = cliente_token.get(f"/?token={SECRETO}", follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"] == "/"


def test_bootstrap_con_token_incorrecto_da_401_sin_cookie(cliente_token):
    r = cliente_token.get("/?token=malo", follow_redirects=False)
    assert r.status_code == 401
    assert "set-cookie" not in r.headers


def test_sin_token_configurado_todo_abierto():
    """Sin SPITIFO_TOKEN no hay auth: es el comportamiento de siempre."""
    cliente = TestClient(create_app(None))
    assert cliente.get("/api/health").status_code == 200
    # "/" puede ser el frontend (200) o 404 si no hay dist; nunca 401.
    assert cliente.get("/").status_code != 401


# ------------------------------------------------------------------- MIME
def test_tipos_de_audio_registrados():
    """Android no trae base MIME: hay que registrarlos explícitamente."""
    register_audio_mime_types()
    for ext, mime in AUDIO_MIME_TYPES.items():
        assert mimetypes.guess_type(f"x{ext}")[0] == mime, ext


# -------------------------------------------------------------------- PATH
def test_ffmpeg_dir_se_prepone_al_path(monkeypatch, tmp_path):
    base, otro, ffmpeg = (tmp_path / n for n in ("base", "otro", "ffmpeg"))
    monkeypatch.setenv("PATH", os.pathsep.join([str(base), str(otro)]))

    assert prepend_to_path(str(ffmpeg)) is True
    partes = os.environ["PATH"].split(os.pathsep)
    assert partes[0] == str(ffmpeg)
    assert partes[1:] == [str(base), str(otro)]

    # Idempotente: no se duplica al arrancar dos veces.
    assert prepend_to_path(str(ffmpeg)) is False
    assert os.environ["PATH"].split(os.pathsep).count(str(ffmpeg)) == 1


def test_ffmpeg_dir_vacio_no_toca_el_path(monkeypatch):
    monkeypatch.setenv("PATH", "algo")
    assert prepend_to_path("") is False
    assert os.environ["PATH"] == "algo"


def test_setup_ffmpeg_dir_lee_la_variable(monkeypatch, tmp_path):
    ffmpeg = tmp_path / "ffmpeg"
    monkeypatch.setenv("PATH", str(tmp_path / "base"))
    monkeypatch.setenv("SPITIFO_FFMPEG_DIR", str(ffmpeg))
    assert setup_ffmpeg_dir() is True
    assert os.environ["PATH"].split(os.pathsep)[0] == str(ffmpeg)


# ------------------------------------------------------------- entry point
def _spawn(env_extra: dict) -> tuple[subprocess.Popen, list, list]:
    env = dict(os.environ)
    for var in ("SPITIFO_TOKEN", "SPITIFO_HOST", "SPITIFO_PORT"):
        env.pop(var, None)
    env.update(env_extra)
    env["PYTHONPATH"] = str(RAIZ)
    proc = subprocess.Popen(
        [sys.executable, "-u", "-m", "backend.app", "--port", "0"],
        cwd=str(RAIZ), env=env, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")

    out: list[str] = []
    err: list[str] = []

    def drenar(stream, destino):
        for linea in stream:
            destino.append(linea)

    # Hilos daemon: sin esto los pipes se llenan y el chico se cuelga.
    threading.Thread(target=drenar, args=(proc.stdout, out), daemon=True).start()
    threading.Thread(target=drenar, args=(proc.stderr, err), daemon=True).start()
    return proc, out, err


def _esperar_puerto(proc, out: list, err: list, timeout: float = 30.0) -> int:
    limite = time.monotonic() + timeout
    visto = 0
    while time.monotonic() < limite:
        if len(out) > visto:
            linea = out[visto]
            visto += 1
            if linea.startswith(READY_PREFIX):
                return int(linea.strip().split("=", 1)[1])
            continue
        if proc.poll() is not None:
            raise AssertionError(
                f"el backend murio sin estar listo.\nstderr:\n{''.join(err)}")
        time.sleep(0.05)
    raise AssertionError(
        f"no aparecio {READY_PREFIX!r} en {timeout}s.\n"
        f"stdout:\n{''.join(out)}\nstderr:\n{''.join(err)}")


def _get(url: str, headers: dict | None = None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _bajar(proc) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)


def test_entry_point_anuncia_puerto_y_responde(tmp_path):
    proc, out, err = _spawn({"SPITIFO_LIBRARY": str(tmp_path / "library")})
    try:
        puerto = _esperar_puerto(proc, out, err)
        assert puerto > 0, "con --port 0 el puerto real tiene que estar reportado"

        estado, cuerpo = _get(f"http://127.0.0.1:{puerto}/api/health")
        assert estado == 200
        assert json.loads(cuerpo)["ok"] is True
    finally:
        _bajar(proc)


def test_entry_point_stdout_solo_lleva_la_linea_ready(tmp_path):
    """El access log de uvicorn va a stdout por defecto. Un shell que solo lee
    la linea READY y deja de drenar stdout terminaria con el pipe lleno y el
    server bloqueado: stdout tiene que quedar con esa unica linea."""
    proc, out, err = _spawn({"SPITIFO_LIBRARY": str(tmp_path / "library")})
    try:
        puerto = _esperar_puerto(proc, out, err)
        for _ in range(3):
            assert _get(f"http://127.0.0.1:{puerto}/api/health")[0] == 200
        time.sleep(0.5)  # que el access log, si fuera a stdout, llegue
    finally:
        _bajar(proc)
    assert [l for l in out if l.strip()] == [f"{READY_PREFIX}{puerto}\n"], out


def test_entry_point_con_token_exige_el_header(tmp_path):
    proc, out, err = _spawn({
        "SPITIFO_LIBRARY": str(tmp_path / "library"),
        "SPITIFO_TOKEN": SECRETO,
    })
    try:
        puerto = _esperar_puerto(proc, out, err)
        url = f"http://127.0.0.1:{puerto}/api/health"

        estado, cuerpo = _get(url)
        assert estado == 401
        assert json.loads(cuerpo) == {"detail": "unauthorized"}

        estado, cuerpo = _get(url, {HEADER_NAME: SECRETO})
        assert estado == 200
        assert json.loads(cuerpo)["ok"] is True
    finally:
        _bajar(proc)
