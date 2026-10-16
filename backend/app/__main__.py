"""Entry point embebible: `python -m backend.app`.

Levanta uvicorn programáticamente en vez de por CLI, porque un shell nativo
(Tauri en Windows, Chaquopy/WebView en Android) necesita saber DOS cosas que la
CLI no le puede dar: en qué puerto quedó escuchando realmente (con `--port 0`
lo elige el SO) y cuándo está listo para recibir requests.

Por eso, una vez que el server está efectivamente escuchando, imprime UNA línea
machine-readable en stdout y la flushea:

    SPITIFO_READY port=51234

Los logs de uvicorn siguen yendo a stderr, así que stdout queda limpio para esa
única línea y el shell la puede parsear sin ambigüedad.
"""
from __future__ import annotations

import argparse
import copy
import os
import sys
from typing import Sequence

import uvicorn

READY_PREFIX = "SPITIFO_READY port="


def _env_int(name: str, default: int) -> int:
    """Lee un entero del entorno; si no se puede, avisa y usa el default."""
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        print(f"[spitifo] {name}={raw!r} no es un entero, uso {default}",
              file=sys.stderr)
        return default


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m backend.app",
        description="Sirve el backend de Spitifo (embebible: Tauri/Chaquopy).")
    p.add_argument("--host", default=os.getenv("SPITIFO_HOST") or "127.0.0.1",
                   help="interfaz donde escuchar "
                        "(default: SPITIFO_HOST o 127.0.0.1)")
    p.add_argument("--port", type=int, default=_env_int("SPITIFO_PORT", 0),
                   help="puerto donde escuchar; 0 elige uno libre "
                        "(default: SPITIFO_PORT o 0)")
    return p


def bound_port(server: uvicorn.Server) -> int:
    """Puerto real de escucha: con port 0 solo se sabe después del startup."""
    for srv in getattr(server, "servers", None) or ():
        for sock in getattr(srv, "sockets", None) or ():
            try:
                return int(sock.getsockname()[1])
            except OSError:
                continue
    raise RuntimeError("el server todavia no escucha: no hay puerto")


class _ReadyServer(uvicorn.Server):
    """uvicorn.Server que avisa por stdout apenas termina el startup."""

    async def startup(self, sockets=None) -> None:
        await super().startup(sockets=sockets)
        print(f"{READY_PREFIX}{bound_port(self)}", flush=True)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    # Import tardío: `--help` no tiene que arrastrar starlette ni las fuentes.
    from .main import app

    # uvicorn manda el access log a stdout por defecto. Si el shell solo lee
    # la linea READY y deja de drenar stdout, el pipe se llena y el server se
    # bloquea: todo log va a stderr.
    log_config = copy.deepcopy(uvicorn.config.LOGGING_CONFIG)
    log_config["handlers"]["access"]["stream"] = "ext://sys.stderr"
    config = uvicorn.Config(app, host=args.host, port=args.port,
                            log_level="info", log_config=log_config)
    _ReadyServer(config).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
