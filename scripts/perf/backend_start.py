#!/usr/bin/env python3
"""Time the backend's start-up and its first requests, the way the shell does.

    python scripts/perf/backend_start.py --exe "%LOCALAPPDATA%\\Spitifo\\backend\\spitifo-backend.exe" \
        --library <dir> [--data-dir <dir>] [--runs 5]
    python scripts/perf/backend_start.py --python .venv\\Scripts\\python.exe --library <dir>

Starts the backend with the same environment the Tauri shell sets (port 0, a
fresh token, the library, the frontend and ffmpeg folders), then reports for
every run:

- `ready_ms`: process spawn until the `SPITIFO_READY port=` line, which is when
  the shell can point the window at the backend;
- `index_ms`: GET / (the page the window loads first);
- `library1_ms` / `library2_ms`: the first and the second GET /api/library;
- `count`: how many entries /api/library returned.

`--exe` runs the frozen sidecar of an installed app (its `frontend` and
`ffmpeg` folders are found next to `backend`); `--python` runs
`python -m backend.app` from this checkout instead. Without `--data-dir` the
backend uses the user's real data folder, so the active storage (local or
Drive) is whatever the app is set to. Stdlib only.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import statistics
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
READY = "SPITIFO_READY port="


def get(url: str, token: str) -> tuple[float, bytes]:
    req = urllib.request.Request(url, headers={"X-Spitifo-Token": token})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = resp.read()
    return (time.perf_counter() - t0) * 1000, body


def one_run(cmd: list[str], env: dict[str, str], cwd: Path) -> dict:
    token = secrets.token_hex(32)
    env = {**env, "SPITIFO_TOKEN": token}
    t0 = time.perf_counter()
    proc = subprocess.Popen(cmd, env=env, cwd=cwd, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True, encoding="utf-8")
    try:
        port = None
        for line in proc.stdout:
            if line.startswith(READY):
                port = int(line[len(READY):].strip())
                break
        if port is None:
            raise RuntimeError(f"backend exited with {proc.wait()} before READY")
        ready_ms = (time.perf_counter() - t0) * 1000
        # Keep draining stdout, as the shell does.
        threading.Thread(target=lambda: [None for _ in proc.stdout], daemon=True).start()
        base = f"http://127.0.0.1:{port}"
        index_ms, _ = get(f"{base}/", token)
        library1_ms, body = get(f"{base}/api/library", token)
        library2_ms, _ = get(f"{base}/api/library", token)
        data = json.loads(body)
        return {"ready_ms": round(ready_ms), "index_ms": round(index_ms),
                "library1_ms": round(library1_ms), "library2_ms": round(library2_ms),
                "count": data.get("count"), "storage": data.get("library")}
    finally:
        proc.kill()
        proc.wait()


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--exe", type=Path, help="installed spitifo-backend.exe")
    src.add_argument("--python", help="interpreter that runs python -m backend.app")
    p.add_argument("--library", type=Path, required=True)
    p.add_argument("--data-dir", type=Path)
    p.add_argument("--runs", type=int, default=5)
    p.add_argument("--json", action="store_true", help="print one JSON object")
    args = p.parse_args()

    env = {**os.environ, "SPITIFO_PORT": "0", "SPITIFO_LIBRARY": str(args.library),
           "YTDLP_ENABLED": "1", "PYTHONIOENCODING": "utf-8"}
    if args.data_dir:
        env["SPITIFO_DATA_DIR"] = str(args.data_dir)
    if args.exe:
        install = args.exe.resolve().parent.parent
        cmd, cwd = [str(args.exe)], install
        env["SPITIFO_FRONTEND_DIST"] = str(install / "frontend")
        env["SPITIFO_FFMPEG_DIR"] = str(install / "ffmpeg")
    else:
        cmd, cwd = [args.python, "-m", "backend.app"], ROOT
        env["SPITIFO_FRONTEND_DIST"] = str(ROOT / "frontend" / "dist")

    runs = []
    for i in range(args.runs):
        r = one_run(cmd, env, cwd)
        runs.append(r)
        if not args.json:
            print(f"run {i + 1}: " + "  ".join(f"{k}={v}" for k, v in r.items()))
    keys = ("ready_ms", "index_ms", "library1_ms", "library2_ms")
    median = {k: round(statistics.median(r[k] for r in runs)) for k in keys}
    if args.json:
        print(json.dumps({"runs": runs, "median": median}))
    else:
        print("median: " + "  ".join(f"{k}={v}" for k, v in median.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
