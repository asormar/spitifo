"""Prueba de Drive desde el telefono con un access token que trae el shell.

En Android el login de Google no pasa por el loopback: lo hace Kotlin con el
Identity Services SDK y le entrega a Python solo el access token (ADR 0002,
secciones 2 y 3). Esto comprueba que ese token sirve desde Python y mide, con la
red del telefono, lo mismo que `bench` mide en la PC, contra el archivo que el
benchmark ya subio a la carpeta `Spitifo`.

No sube nada ni pide tokens: solo lee.
"""
from __future__ import annotations

import json
from dataclasses import asdict
from typing import Callable

import httpx

from .bench import (
    DRIVE_FILES_URL,
    FOLDER_NAME,
    _q,
    drive_find_folder,
    measure_full,
    measure_range,
    summarize_ms,
)

#: Mismo tamano de rango que el benchmark de PC, para comparar.
CHUNK = 65536


def find_bench_file(client: httpx.Client, headers: dict[str, str]) -> dict | None:
    """El primer `bench-*` de la carpeta `Spitifo`, o None si no hay."""
    folder_id = drive_find_folder(client, headers, FOLDER_NAME)
    if folder_id is None:
        return None
    resp = client.get(
        DRIVE_FILES_URL,
        params={"q": (f"'{_q(folder_id)}' in parents and name contains 'bench-' "
                      f"and trashed=false"),
                "fields": "files(id,name,size)"},
        headers=headers)
    resp.raise_for_status()
    files = resp.json().get("files") or []
    return files[0] if files else None


def _new_client(timeout: float) -> httpx.Client:
    return httpx.Client(timeout=timeout)


def probe(access_token: str, runs: int = 5,
          make_client: Callable[[float], httpx.Client] = _new_client) -> str:
    """Corre la prueba y devuelve un informe JSON (lo muestra el shell).

    Nunca levanta: cualquier fallo vuelve como `{"ok": false, "error": ...}`,
    porque del otro lado hay una pantalla de Kotlin, no una terminal.
    `make_client` existe para los tests (MockTransport).
    """
    headers = {"Authorization": f"Bearer {access_token}"}
    try:
        with make_client(30.0) as client:
            found = find_bench_file(client, headers)
        if found is None:
            return json.dumps({"ok": False, "error": (
                "no bench-* file in the Spitifo folder: run the PC benchmark "
                "first")})
        size = int(found["size"])
        url = f"{DRIVE_FILES_URL}/{found['id']}?alt=media"
        first_end = min(CHUNK, size) - 1
        seek_start = size // 2
        seek_end = min(seek_start + CHUNK, size) - 1

        samples: dict[str, list[dict]] = {"first_bytes": [], "seek_middle": []}
        for _ in range(runs):
            # Cliente nuevo por corrida: conexion TLS fresca, como en la PC.
            with make_client(60.0) as client:
                samples["first_bytes"].append(asdict(measure_range(
                    client, url, 0, first_end, CHUNK, headers=headers)))
            with make_client(60.0) as client:
                samples["seek_middle"].append(asdict(measure_range(
                    client, url, seek_start, seek_end, CHUNK, headers=headers)))
        with make_client(300.0) as client:
            full = measure_full(client, url, headers=headers)
    except httpx.HTTPStatusError as exc:
        return json.dumps({"ok": False,
                           "error": f"HTTP {exc.response.status_code} from Drive"})
    except httpx.HTTPError as exc:
        return json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"})

    failures = sum(1 for recs in samples.values() for r in recs if not r["ok"])
    return json.dumps({
        "ok": failures == 0 and full.ok,
        "file": found["name"],
        "size_bytes": size,
        "first_chunk": summarize_ms([r["first_chunk_s"] for r in samples["first_bytes"]]),
        "seek_chunk": summarize_ms([r["first_chunk_s"] for r in samples["seek_middle"]]),
        "full_download_s": round(full.total_s, 2),
        "throughput_kbit_s": round(full.throughput_kbit_s),
        "max_gap_ms": round(full.max_gap_s * 1000),
        "range_failures": failures,
    })
