"""Android entry point: runs the unmodified backend for the native WebView.

Kotlin sets every environment variable the backend reads (SPITIFO_TOKEN,
SPITIFO_LIBRARY, SPITIFO_TEMP_DIR, SPITIFO_FRONTEND_DIST, SPITIFO_FFMPEG_DIR,
SPITIFO_PLATFORM, YTDLP_ENABLED, HOME) BEFORE importing this module, because
`backend.app.main` reads them while importing: `SPITIFO_TOKEN` builds the auth
middleware, `SPITIFO_FRONTEND_DIST` decides whether the static mount exists and
`SPITIFO_LIBRARY` / `SPITIFO_TEMP_DIR` are resolved at import of downloader.py.
`SPITIFO_PLATFORM` only changes how the Drive token is obtained (the app pushes
it in; see backend/app/cloud/android.py).

Nothing else is patched: the same app desktop ships is what Android serves.
"""
from __future__ import annotations

import copy
import logging
import time

import uvicorn

from backend.app.__main__ import bound_port

log = logging.getLogger("spitifo.android")


def serve(listener) -> None:
    """Blocking: serve the backend on 127.0.0.1 and report readiness.

    Called on a Kotlin daemon thread, so it never returns while the process
    lives. `listener` is a Kotlin object implementing Backend.ServeListener;
    its methods are called from this thread.
    """
    t0 = time.perf_counter()
    try:
        # Late import: it is heavy (starlette, the five sources, yt_dlp) and
        # anything that throws has to reach the listener as a readable message
        # instead of killing the thread silently.
        from backend.app.main import app
    except Exception as e:  # noqa: BLE001 - the shell needs *some* message
        log.exception("backend import failed")
        listener.onFailed("backend import failed: %s" % e)
        return

    log.info("backend imported in %.1f s", time.perf_counter() - t0)

    # The backend announces download activity through a plain Python callable,
    # so the Kotlin object is wrapped instead of registered as-is. Registered
    # here, before the first request can arrive, so no download is ever missed.
    from backend.app import activity
    activity.add_listener(lambda busy: listener.onBusyChanged(busy))

    # Port 0: the OS picks a free one. The real port is only known once uvicorn
    # has finished starting, which is what _AndroidServer reports back.
    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="info",
                            log_config=_log_config())
    server = _AndroidServer(config, listener)
    try:
        server.run()
    except Exception as e:  # noqa: BLE001
        log.exception("server died")
        listener.onFailed("server died: %s" % e)


def _log_config() -> dict:
    """uvicorn's default logging with the access log on stderr.

    Same shape as backend/app/__main__.main(): stdout stays reserved for the
    shell. There is no READY line to protect here (readiness travels through
    the listener), but Chaquopy mirrors both streams to logcat and keeping the
    split makes the two entry points behave identically.
    """
    log_config = copy.deepcopy(uvicorn.config.LOGGING_CONFIG)
    log_config["handlers"]["access"]["stream"] = "ext://sys.stderr"
    return log_config


class _AndroidServer(uvicorn.Server):
    """uvicorn server that reports the bound port as soon as it listens.

    `uvicorn.Server.run` only returns after the server stops, so readiness has
    to be announced from inside startup, exactly like `_ReadyServer` in
    backend/app/__main__.py does its READY line.
    """

    def __init__(self, config: uvicorn.Config, listener) -> None:
        super().__init__(config)
        self._listener = listener

    async def startup(self, sockets=None) -> None:
        await super().startup(sockets=sockets)
        port = bound_port(self)
        log.info("listening on 127.0.0.1:%d", port)
        self._listener.onReady(port)
