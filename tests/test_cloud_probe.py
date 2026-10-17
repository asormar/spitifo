"""Tests OFFLINE de la prueba de Drive del telefono (backend/app/cloud/probe.py).

Un Drive falso en `httpx.MockTransport`: carpeta `Spitifo`, un `bench-*` y
descargas con `Range`.
"""
from __future__ import annotations

import json
import re

import httpx

from backend.app.cloud import probe

DATA = bytes(range(256)) * 1024  # 256 KiB


def _drive(request: httpx.Request) -> httpx.Response:
    assert request.headers["Authorization"] == "Bearer tok"
    if request.url.path == "/drive/v3/files":
        q = request.url.params["q"]
        if "mimeType='application/vnd.google-apps.folder'" in q:
            return httpx.Response(200, json={"files": [{"id": "fold", "name": "Spitifo"}]})
        assert "'fold' in parents" in q
        return httpx.Response(200, json={"files": [
            {"id": "f1", "name": "bench-a.m4a", "size": str(len(DATA))}]})
    assert request.url.path == "/drive/v3/files/f1"
    rng = request.headers.get("Range")
    if rng is None:
        return httpx.Response(200, content=DATA)
    start, end = map(int, re.match(r"bytes=(\d+)-(\d+)", rng).groups())
    return httpx.Response(206, content=DATA[start:end + 1], headers={
        "Content-Range": f"bytes {start}-{end}/{len(DATA)}"})


def _factory(handler):
    return lambda timeout: httpx.Client(transport=httpx.MockTransport(handler))


def test_probe_mide_el_archivo_del_benchmark():
    report = json.loads(probe.probe("tok", runs=2, make_client=_factory(_drive)))
    assert report["ok"] is True
    assert report["file"] == "bench-a.m4a"
    assert report["first_chunk"]["n"] == 2
    assert report["seek_chunk"]["n"] == 2
    assert report["range_failures"] == 0


def test_probe_sin_archivo_lo_dice():
    def vacio(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"files": []})

    report = json.loads(probe.probe("tok", make_client=_factory(vacio)))
    assert report["ok"] is False
    assert "PC benchmark" in report["error"]


def test_probe_token_rechazado_no_levanta():
    def rechazo(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"code": 401}})

    report = json.loads(probe.probe("tok", make_client=_factory(rechazo)))
    assert report == {"ok": False, "error": "HTTP 401 from Drive"}
