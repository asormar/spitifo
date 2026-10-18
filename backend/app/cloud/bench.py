"""Benchmark de un proveedor de nube contra los objetivos del ADR 0002.

Mide Google Drive desde una PC con una cuenta real: sube UN archivo de audio a
la carpeta visible del proveedor y despues cronometra el primer byte, el seek al
medio y la descarga completa. Los objetivos que una PC puede chequear estan en
docs/adr/0002-user-owned-storage.md, seccion 2.

Se corre a mano:

    python -m backend.app.cloud.bench google --file track.m4a --runs 10

Los tests NO tocan la red: los ayudantes puros (percentiles, Content-Range,
armado de requests) se prueban offline con `httpx.MockTransport`. Toda funcion
HTTP recibe un `httpx.Client`; las mediciones usan un cliente NUEVO por corrida
(conexion TLS fresca, como una reproduccion sin cache). Los tokens nunca se
imprimen.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
import webbrowser
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Sequence

import httpx

from .connect import provider_for, sign_in
from .oauth import OAuthError, OAuthNotConfigured, Provider, TokenSet, refresh
from .tokens import TokenStore, default_protector, default_token_dir

# ------------------------------------------------------------------- constantes
DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files"
DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"

#: Carpeta visible que crea la app (ADR 0002, seccion 1).
FOLDER_NAME = "Spitifo"
DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"
DRIVE_FIELDS_FOLDER = "files(id,name)"
DRIVE_FIELDS_FILE = "files(id,name,size)"

#: Objetivo del ADR: p50 por debajo de 1 s.
TARGET_P50_MS = 1000.0
#: Objetivo del ADR: bajar al menos 2x mas rapido que la reproduccion.
TARGET_RATIO = 2.0


# ------------------------------------------------------------------- ayudantes
def percentile(values: Sequence[float], p: float) -> float:
    """Percentil con interpolacion lineal, como numpy (p entre 0 y 100)."""
    if not values:
        raise ValueError("percentile de una lista vacia")
    data = sorted(float(v) for v in values)
    if len(data) == 1:
        return data[0]
    k = (len(data) - 1) * (p / 100.0)
    lo = math.floor(k)
    hi = math.ceil(k)
    if lo == hi:
        return data[int(k)]
    return data[lo] + (data[hi] - data[lo]) * (k - lo)


def summarize_ms(samples_s: Sequence[float]) -> dict[str, float]:
    """Resumen p50/p95/min/max en milisegundos a partir de muestras en segundos."""
    return {
        "n": len(samples_s),
        "p50_ms": percentile(samples_s, 50) * 1000.0,
        "p95_ms": percentile(samples_s, 95) * 1000.0,
        "min_ms": min(samples_s) * 1000.0,
        "max_ms": max(samples_s) * 1000.0,
    }


# --------------------------------------------------------------- Content-Range
#: `bytes 0-1023/4096`. El total puede ser `*` cuando el servidor no lo sabe.
_CONTENT_RANGE = re.compile(r"^bytes (\d+)-(\d+)/(\d+|\*)$", re.IGNORECASE)


def parse_content_range(value: str | None) -> tuple[int, int, int | None] | None:
    """`(start, end, total)` de un header Content-Range, o None si no sirve."""
    if not value:
        return None
    match = _CONTENT_RANGE.match(value.strip())
    if match is None:
        return None
    start = int(match.group(1))
    end = int(match.group(2))
    if end < start:
        return None
    total = None if match.group(3) == "*" else int(match.group(3))
    return start, end, total


def range_matches(value: str | None, start: int, end: int) -> bool:
    """True si el Content-Range cubre EXACTAMENTE el rango que se pidio."""
    parsed = parse_content_range(value)
    return parsed is not None and parsed[0] == start and parsed[1] == end


def validate_ranged(status_code: int, content_range: str | None,
                    start: int, end: int) -> bool:
    """Un rango esta bien servido: 206 y Content-Range que coincide."""
    return status_code == 206 and range_matches(content_range, start, end)


# --------------------------------------------------------------- Drive queries
def _q(value: str) -> str:
    """Escapa un literal para el `q` de Drive (`\` y `'` llevan barra)."""
    return value.replace("\\", "\\\\").replace("'", "\\'")


def drive_folder_query(name: str = FOLDER_NAME) -> str:
    """`q` que busca la carpeta visible de la app."""
    return (f"name='{_q(name)}' and mimeType='{DRIVE_FOLDER_MIME}' "
            f"and trashed=false")


def drive_children_query(folder_id: str, name: str) -> str:
    """`q` que busca un archivo por nombre dentro de una carpeta."""
    return (f"name='{_q(name)}' and '{_q(folder_id)}' in parents "
            f"and trashed=false")


def drive_find_folder(client: httpx.Client, headers: dict[str, str],
                      name: str = FOLDER_NAME) -> str | None:
    """Id de la carpeta `Spitifo` o None si todavia no existe."""
    resp = client.get(
        DRIVE_FILES_URL,
        params={"q": drive_folder_query(name), "fields": DRIVE_FIELDS_FOLDER},
        headers=headers)
    resp.raise_for_status()
    files = resp.json().get("files") or []
    return str(files[0]["id"]) if files else None


def drive_create_folder(client: httpx.Client, headers: dict[str, str],
                        name: str = FOLDER_NAME) -> str:
    """Crea la carpeta visible y devuelve su id."""
    resp = client.post(
        DRIVE_FILES_URL,
        json={"name": name, "mimeType": DRIVE_FOLDER_MIME},
        headers=headers)
    resp.raise_for_status()
    return str(resp.json()["id"])


def drive_find_or_create_folder(client: httpx.Client, headers: dict[str, str],
                                name: str = FOLDER_NAME) -> str:
    """Busca la carpeta y, si no esta, la crea. Devuelve su id."""
    folder_id = drive_find_folder(client, headers, name)
    return folder_id if folder_id else drive_create_folder(client, headers, name)


def drive_find_file(client: httpx.Client, headers: dict[str, str],
                    folder_id: str, name: str) -> dict | None:
    """Metadata `{id,name,size}` del archivo en la carpeta, o None."""
    resp = client.get(
        DRIVE_FILES_URL,
        params={"q": drive_children_query(folder_id, name),
                "fields": DRIVE_FIELDS_FILE},
        headers=headers)
    resp.raise_for_status()
    files = resp.json().get("files") or []
    return files[0] if files else None


def drive_upload(client: httpx.Client, headers: dict[str, str], folder_id: str,
                 name: str, data: bytes) -> str:
    """Sube el archivo con una sesion resumable de UNA sola request PUT."""
    start = client.post(
        DRIVE_UPLOAD_URL,
        params={"uploadType": "resumable"},
        json={"name": name, "parents": [folder_id]},
        headers=headers)
    start.raise_for_status()
    location = start.headers.get("Location")
    if not location:
        raise OAuthError("Drive no devolvio el header Location de la sesion")
    put = client.put(location, content=data,
                     headers={"Content-Type": "application/octet-stream"})
    put.raise_for_status()
    body = put.json() if put.content else {}
    return str(body.get("id") or "")


def drive_ensure_file(client: httpx.Client, headers: dict[str, str],
                      folder_id: str, name: str,
                      data: bytes) -> tuple[str, bool]:
    """Id del archivo en la carpeta: reusa el que ya tiene el mismo tamano."""
    found = drive_find_file(client, headers, folder_id, name)
    if found and int(found.get("size", -1)) == len(data):
        return str(found["id"]), True
    return drive_upload(client, headers, folder_id, name, data), False


# --------------------------------------------------------------- mediciones
@dataclass
class RangeTiming:
    """Resultado de un GET con `Range` que se lee en streaming."""

    first_byte_s: float
    first_chunk_s: float
    status_code: int
    content_range: str | None
    ok: bool
    error: str | None = None


def measure_range(client: httpx.Client, url: str, start: int, end: int,
                  chunk: int, *, headers: dict[str, str] | None = None,
                  follow_redirects: bool = False) -> RangeTiming:
    """Cronometra el primer byte y los primeros `chunk` bytes de un rango.

    `first_byte_s` es lo que tarda en llegar el primer byte y `first_chunk_s` lo
    que tarda en juntarse `chunk` bytes (el proxy del tiempo hasta el primer
    audio). Valida que la respuesta sea 206 con un Content-Range que coincida.
    """
    request_headers = dict(headers or {})
    request_headers["Range"] = f"bytes={start}-{end}"
    t0 = time.perf_counter()
    first_byte: float | None = None
    first_chunk: float | None = None
    received = 0
    status = 0
    content_range: str | None = None
    try:
        with client.stream("GET", url, headers=request_headers,
                           follow_redirects=follow_redirects) as resp:
            status = resp.status_code
            content_range = resp.headers.get("Content-Range")
            for piece in resp.iter_bytes():
                if not piece:
                    continue
                now = time.perf_counter()
                if first_byte is None:
                    first_byte = now - t0
                received += len(piece)
                if first_chunk is None and received >= chunk:
                    first_chunk = now - t0
        elapsed = time.perf_counter() - t0
    except httpx.HTTPError as exc:
        return RangeTiming(0.0, 0.0, 0, None, False,
                           f"{type(exc).__name__}: {exc}")
    # Un archivo mas chico que el rango pedido no completa `chunk`: vale el total.
    if first_byte is None:
        first_byte = elapsed
    if first_chunk is None:
        first_chunk = elapsed
    ok = validate_ranged(status, content_range, start, end)
    error = None if ok else f"status={status} content-range={content_range!r}"
    return RangeTiming(first_byte, first_chunk, status, content_range, ok, error)


@dataclass
class FullTiming:
    """Resultado de bajar el archivo completo en streaming."""

    total_s: float
    nbytes: int
    throughput_kbit_s: float
    max_gap_s: float
    status_code: int
    ok: bool
    error: str | None = None


def measure_full(client: httpx.Client, url: str, *,
                 headers: dict[str, str] | None = None,
                 follow_redirects: bool = False) -> FullTiming:
    """Baja todo el archivo y mide tiempo, throughput y la pausa mas larga.

    La pausa mas larga entre partes consecutivas es el proxy de un stall. La
    espera hasta el primer byte no cuenta: eso ya lo mide `measure_range`.
    """
    t0 = time.perf_counter()
    previous: float | None = None
    max_gap = 0.0
    nbytes = 0
    status = 0
    try:
        with client.stream("GET", url, headers=headers or {},
                           follow_redirects=follow_redirects) as resp:
            status = resp.status_code
            for piece in resp.iter_bytes():
                if not piece:
                    continue
                now = time.perf_counter()
                if previous is not None and now - previous > max_gap:
                    max_gap = now - previous
                previous = now
                nbytes += len(piece)
        total = time.perf_counter() - t0
    except httpx.HTTPError as exc:
        return FullTiming(0.0, 0, 0.0, 0.0, 0, False,
                          f"{type(exc).__name__}: {exc}")
    throughput = (nbytes * 8 / 1000.0) / total if total > 0 else 0.0
    ok = 200 <= status < 300
    error = None if ok else f"status={status}"
    return FullTiming(total, nbytes, throughput, max_gap, status, ok, error)


def audio_duration(path: Path) -> float | None:
    """Duracion en segundos leida con mutagen. None si no se puede."""
    try:
        from mutagen import File as MFile
        f = MFile(str(path))
        if f is not None and f.info is not None:
            return float(f.info.length)
    except Exception:
        return None
    return None


# --------------------------------------------------------------------- sign-in
@dataclass
class Credentials:
    """Tokens vigentes y como renovarlos sin volver a pedir consentimiento."""

    provider: Provider
    store: TokenStore
    name: str
    tokens: TokenSet

    def headers(self, client: httpx.Client) -> dict[str, str]:
        """Header Authorization, refrescando primero si el token vencio."""
        if self.tokens.expired():
            self.tokens = refresh(client, self.provider, self.tokens)
            self.store.save(self.name, self.tokens)
        return {"Authorization": f"Bearer {self.tokens.access_token}"}


# --------------------------------------------------------------------- informe
def build_summary(samples: dict[str, list[dict]]) -> dict[str, dict]:
    """Resumen en ms por metrica, listo para imprimir y serializar."""
    summary: dict[str, dict] = {}
    for metric, records in samples.items():
        if not records:
            continue
        if metric == "full_download":
            summary[f"{metric}:total"] = summarize_ms(
                [r["total_s"] for r in records])
            summary[f"{metric}:max_gap"] = summarize_ms(
                [r["max_gap_s"] for r in records])
        else:
            summary[f"{metric}:first_byte"] = summarize_ms(
                [r["first_byte_s"] for r in records])
            summary[f"{metric}:first_chunk"] = summarize_ms(
                [r["first_chunk_s"] for r in records])
    return summary


def count_failures(samples: dict[str, list[dict]]) -> dict[str, int]:
    """Cuantas respuestas por metrica no pasaron la validacion."""
    return {metric: sum(1 for r in records if not r.get("ok", True))
            for metric, records in samples.items()}


def evaluate_targets(summary: dict[str, dict], ratio_p50: float | None) -> dict:
    """PASS/FAIL de los objetivos del ADR que una PC puede chequear.

    `None` significa que no hubo datos para evaluar el objetivo.
    """
    first = summary.get("first_bytes:first_chunk")
    seek = summary.get("seek_middle:first_chunk")
    return {
        "first_audio_p50_under_1s": {
            "label": "first audio p50 < 1 s",
            "value_ms": None if not first else first["p50_ms"],
            "pass": None if not first else first["p50_ms"] < TARGET_P50_MS,
        },
        "seek_p50_under_1s": {
            "label": "seek to middle p50 < 1 s",
            "value_ms": None if not seek else seek["p50_ms"],
            "pass": None if not seek else seek["p50_ms"] < TARGET_P50_MS,
        },
        "throughput_ratio_at_least_2": {
            "label": "throughput ratio >= 2 (no stalls likely)",
            "ratio": ratio_p50,
            "pass": None if ratio_p50 is None else ratio_p50 >= TARGET_RATIO,
        },
    }


def _fmt_opt(value: float | None, digits: int = 1) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def print_report(report: dict, out: Callable[[str], object] = print) -> None:
    """Imprime el informe en texto plano. Nunca imprime tokens."""
    out("")
    out(f"Provider: {report['provider']} (command: {report['command']})")
    out(f"File: {report['file']} | {report['size_bytes']} bytes | "
        f"duration: {_fmt_opt(report['duration_s'])} s | "
        f"bitrate: {_fmt_opt(report['bitrate_kbit_s'])} kbit/s")
    out(f"Runs: {report['runs']} | full downloads: {report['full_runs']} | "
        f"chunk: {report['chunk']} bytes | upload: "
        f"{'reused' if report['upload_reused'] else 'new'}")
    out("")
    out("Times in milliseconds")
    out(f"{'metric':<34}{'n':>4}{'p50':>11}{'p95':>11}{'min':>11}{'max':>11}")
    for key in sorted(report["summary"]):
        row = report["summary"][key]
        out(f"{key:<34}{row['n']:>4}{row['p50_ms']:>11.1f}"
            f"{row['p95_ms']:>11.1f}{row['min_ms']:>11.1f}"
            f"{row['max_ms']:>11.1f}")

    failures = {k: v for k, v in report["failures"].items() if v}
    if failures:
        out("")
        out("Ranged responses that failed validation: " + ", ".join(
            f"{k}={v}" for k, v in sorted(failures.items())))
    else:
        out("")
        out("Ranged responses: all 206 with a matching Content-Range")

    throughput = report["throughput"]
    if throughput:
        out(f"Full download throughput p50: "
            f"{_fmt_opt(throughput['p50_kbit_s'])} kbit/s | "
            f"ratio vs bitrate p50: {_fmt_opt(throughput['ratio_p50'], 2)}")

    out("")
    out("Targets (docs/adr/0002-user-owned-storage.md, section 2)")
    for key in ("first_audio_p50_under_1s", "seek_p50_under_1s",
                "throughput_ratio_at_least_2"):
        target = report["targets"][key]
        if target["pass"] is None:
            out(f"  [SKIP] {target['label']} (no data)")
        elif target["pass"]:
            out(f"  [PASS] {target['label']} "
                f"({_target_value(target)})")
        else:
            out(f"  [FAIL] {target['label']} "
                f"({_target_value(target)})")


def _target_value(target: dict) -> str:
    if target.get("value_ms") is not None:
        return f"p50 = {target['value_ms']:.1f} ms"
    return f"ratio = {_fmt_opt(target.get('ratio'), 2)}"


# --------------------------------------------------------------------- runner
def run_provider(which: str, file_path: Path | str, runs: int, chunk: int,
                 *, browser: Callable[[str], object] = webbrowser.open,
                 out: Callable[[str], object] = print) -> dict:
    """Corre el benchmark completo de un proveedor y devuelve el informe."""
    if runs < 1:
        raise ValueError("--runs tiene que ser >= 1")
    if chunk < 1:
        raise ValueError("--chunk tiene que ser >= 1")

    path = Path(file_path)
    data = path.read_bytes()
    size = len(data)
    remote_name = f"bench-{path.name}"

    provider = provider_for(which)
    store = TokenStore(default_token_dir(), default_protector())
    tokens = sign_in(provider, store, f"bench-{provider.name}",
                     browser=browser, out=out)
    if tokens is None:
        raise SystemExit(2)
    creds = Credentials(provider, store, f"bench-{provider.name}", tokens)

    with httpx.Client(timeout=120.0) as client:
        headers = creds.headers(client)
        folder_id = drive_find_or_create_folder(client, headers, FOLDER_NAME)
        item_id, upload_reused = drive_ensure_file(
            client, headers, folder_id, remote_name, data)
    out(f"Item: {item_id} | "
        f"{'reused existing upload' if upload_reused else 'uploaded'}")

    direct_url = f"{DRIVE_FILES_URL}/{item_id}?alt=media"
    follow = False

    samples: dict[str, list[dict]] = {}
    first_end = min(chunk, size) - 1
    seek_start = size // 2
    seek_end = min(seek_start + chunk, size) - 1

    for _ in range(runs):
        with httpx.Client(timeout=120.0) as client:
            headers = creds.headers(client)
            timing = measure_range(client, direct_url, 0, first_end, chunk,
                                   headers=headers, follow_redirects=follow)
        samples.setdefault("first_bytes", []).append(asdict(timing))

    for _ in range(runs):
        with httpx.Client(timeout=120.0) as client:
            headers = creds.headers(client)
            timing = measure_range(client, direct_url, seek_start, seek_end,
                                   chunk, headers=headers,
                                   follow_redirects=follow)
        samples.setdefault("seek_middle", []).append(asdict(timing))

    full_runs = min(3, runs)
    for _ in range(full_runs):
        with httpx.Client(timeout=600.0) as client:
            headers = creds.headers(client)
            timing = measure_full(client, direct_url, headers=headers,
                                  follow_redirects=follow)
        samples.setdefault("full_download", []).append(asdict(timing))

    duration = audio_duration(path)
    bitrate_kbit_s = (None if not duration
                      else size * 8 / 1000.0 / duration)

    ratios: list[float] = []
    if duration:
        for record in samples.get("full_download", []):
            if record["total_s"] > 0:
                ratios.append(duration / record["total_s"])
    ratio_p50 = percentile(ratios, 50) if ratios else None

    full_records = samples.get("full_download", [])
    throughput = None
    if full_records:
        throughput = {
            "p50_kbit_s": percentile(
                [r["throughput_kbit_s"] for r in full_records], 50),
            "ratio_p50": ratio_p50,
        }

    summary = build_summary(samples)
    return {
        "provider": provider.name,
        "command": which,
        "file": str(path),
        "size_bytes": size,
        "duration_s": duration,
        "bitrate_kbit_s": bitrate_kbit_s,
        "runs": runs,
        "full_runs": full_runs,
        "chunk": chunk,
        "item_id": item_id,
        "remote_name": remote_name,
        "upload_reused": upload_reused,
        "samples": samples,
        "summary": summary,
        "failures": count_failures(samples),
        "throughput": throughput,
        "targets": evaluate_targets(summary, ratio_p50),
    }


# ------------------------------------------------------------------------ CLI
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m backend.app.cloud.bench",
        description="Mide Google Drive contra los objetivos del ADR 0002 "
                    "(seccion 2).")
    parser.add_argument("provider", choices=("google",),
                        help="proveedor a medir")
    parser.add_argument("--file", required=True,
                        help="archivo de audio a subir y medir")
    parser.add_argument("--runs", type=int, default=10,
                        help="corridas por metrica (default: 10)")
    parser.add_argument("--chunk", type=int, default=65536,
                        help="bytes por rango medido, 64 KiB (default: 65536)")
    parser.add_argument("--json", dest="json_path", default=None,
                        help="escribe las muestras crudas en este archivo")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    path = Path(args.file)
    if not path.is_file():
        print(f"[bench] no existe el archivo: {path}", file=sys.stderr)
        return 2
    try:
        report = run_provider(args.provider, path, args.runs, args.chunk)
    except (OAuthError, OAuthNotConfigured) as exc:
        print(f"[bench] {exc}", file=sys.stderr)
        return 2
    print_report(report)
    if args.json_path:
        Path(args.json_path).write_text(
            json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False),
            encoding="utf-8")
        print(f"JSON written to {args.json_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
