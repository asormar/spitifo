"""Puente de tokens de Google Drive en Android (ADR 0002, secciones 2, 3 y 7).

En la PC el sign-in es un flujo OAuth por loopback (`cloud/connect.py`) y los
refresh tokens quedan en disco (`tokens.StoredTokenSource`). En Android eso no
existe: no hay navegador propio, ni client secret, ni redirect. El host Kotlin
le pide un access token a Google (Identity Services `AuthorizationClient`, scope
`drive.file`) y lo empuja a este modulo, que lo sirve con `StaticTokenSource`.

`connected` no es el token —vive solo en memoria y lo reempuja Kotlin en cada
arranque— sino la marca persistida de `settings.py`: sin ella, reiniciar la app
pareceria una desconexion.

Las funciones de nivel de modulo (`set_token`, `connect_failed`,
`is_google_connected`) son lo que Kotlin llama por Chaquopy. Modulo neutral: no
importa starlette ni uvicorn.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Callable

from .settings import google_connected, set_google_connected
from .tokens import StaticTokenSource

log = logging.getLogger(__name__)

#: Variable que `Backend.setUp` deja puesta antes de importar el backend.
PLATFORM_ENV = "SPITIFO_PLATFORM"

#: Proveedores que Android sabe conectar: el host solo pide el scope de Drive.
PROVIDERS = ("google",)


def is_android() -> bool:
    """True si este proceso corre dentro de la app Android.

    Se lee en cada llamada y no al importar: los tests (y el backend de la PC)
    cambian la variable en caliente.
    """
    return os.getenv(PLATFORM_ENV, "").strip().lower() == "android"


#: Un unico `StaticTokenSource` por proceso: el mismo objeto que llena Kotlin y
#: que usan todos los adapters, aunque `reset_storage()` los rearme.
_tokens: StaticTokenSource | None = None
_tokens_lock = threading.Lock()


def android_tokens() -> StaticTokenSource:
    """El origen de tokens del proceso en Android (se crea la primera vez)."""
    global _tokens
    with _tokens_lock:
        if _tokens is None:
            _tokens = StaticTokenSource()
        return _tokens


#: Flujo pendiente del proceso. Lo registra `AndroidConnectFlow.__init__`, que
#: es quien tiene el callback de `main.py`; las funciones de abajo lo buscan.
_flow: AndroidConnectFlow | None = None
_flow_lock = threading.Lock()


def _current_flow() -> AndroidConnectFlow | None:
    with _flow_lock:
        return _flow


class AndroidConnectFlow:
    """`ConnectFlow` sin navegador: espera a que Kotlin empuje el token.

    Expone la misma superficie que usa `main.py` (`status`, `start`, `cancel`,
    `is_connected`, `disconnect`). `start()` deja el flujo en `pending` y
    devuelve None (no hay URL que abrir); el cierre lo disparan `set_token()` o
    `connect_failed()`.
    """

    def __init__(
            self, on_connected: Callable[[str], None] | None = None) -> None:
        global _flow
        self._on_connected = on_connected
        self._lock = threading.Lock()
        self._state = "idle"
        self._provider: str | None = None
        self._error: str | None = None
        # Un flujo por proceso, igual que `main._connect_flow`.
        with _flow_lock:
            _flow = self

    def start(self, provider_id: str) -> None:
        """Deja el flujo pendiente. Devuelve None: en Android nada se abre."""
        with self._lock:
            self._state = "pending"
            self._provider = provider_id
            self._error = None
        return None

    def status(self) -> dict:
        """`{state, provider, error}`: lo que la UI necesita para pintarse."""
        with self._lock:
            return {"state": self._state, "provider": self._provider,
                    "error": self._error}

    def cancel(self) -> None:
        """Cancela el flujo en curso. Si no hay ninguno, no hace nada."""
        with self._lock:
            if self._state != "pending":
                return
            self._state = "cancelled"
            self._error = None

    def is_connected(self, provider_id: str) -> bool:
        """En Android "conectado" es la marca persistida, no el token."""
        return provider_id in PROVIDERS and google_connected()

    def disconnect(self, provider_id: str) -> None:
        """Tira el token de memoria y olvida la marca (no toca el ajuste activo)."""
        if provider_id not in PROVIDERS:
            raise ValueError(f"proveedor desconocido: {provider_id!r}")
        android_tokens().invalidate()
        set_google_connected(False)

    # ------------------------------------------------- lo que reporta Kotlin
    def _token_received(self, interactive: bool) -> None:
        """Token nuevo: si habia un connect pendiente, queda conectado."""
        with self._lock:
            if self._state != "pending":
                return
            self._state = "connected"
            self._error = None
            provider = self._provider or "google"
        if self._on_connected is not None:
            try:
                self._on_connected(provider)
            except Exception:
                # El flujo ya esta conectado: un fallo de la UI no lo tumba.
                log.exception("on_connected fallo")

    def _failed(self, message: str, cancelled: bool) -> None:
        with self._lock:
            if self._state != "pending":
                return
            self._state = "cancelled" if cancelled else "error"
            self._error = None if cancelled else message


def set_token(token: str, expires_at: float, interactive: bool = False) -> None:
    """Kotlin empuja un access token: se guarda y Google queda como conectado.

    `expires_at` es epoch en segundos. `interactive` distingue el token que sale
    del consentimiento del que llega por un refresco silencioso: solo se usa
    para el log.
    """
    android_tokens().set(token, float(expires_at))
    set_google_connected(True)
    log.info("token de Google (%s), vence en %.0f s",
             "interactivo" if interactive else "silencioso",
             float(expires_at) - time.time())
    flow = _current_flow()
    if flow is not None:
        flow._token_received(interactive)


def connect_failed(message: str, cancelled: bool = False) -> None:
    """Kotlin informa que el sign-in no salio (o que el usuario lo cancelo)."""
    flow = _current_flow()
    if flow is not None:
        flow._failed(message, cancelled)


def is_google_connected() -> bool:
    """Marca persistida de Google conectado (Kotlin la consulta al arrancar)."""
    return google_connected()
