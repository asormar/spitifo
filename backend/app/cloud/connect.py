"""CLI para conectar un proveedor de nube desde la PC (ADR 0002, secciones 3 y 8).

El flujo de consentimiento por loopback vivia en `bench.py`; se mudo aca porque
conectar la biblioteca es una accion propia y no una medicion. `bench` reusa
`sign_in` con su propio nombre de tokens.

    python -m backend.app.cloud.connect google
    python -m backend.app.cloud.connect google --disconnect

Los tokens quedan guardados bajo el nombre del proveedor (`google`), que es el
que `drive_storage_from_env` usa despues.
"""
from __future__ import annotations

import argparse
import logging
import sys
import threading
import webbrowser
from typing import Callable, Sequence

import httpx

from .oauth import (
    InvalidGrant,
    LoopbackReceiver,
    OAuthError,
    OAuthNotConfigured,
    Provider,
    SignInCancelled,
    SignInTimeout,
    TokenSet,
    authorize_url,
    exchange_code,
    google_provider,
    new_pkce,
    new_state,
    refresh,
)
from .tokens import TokenStore, default_protector, default_token_dir

log = logging.getLogger(__name__)

#: Margen del flujo de consentimiento en el loopback.
SIGN_IN_TIMEOUT = 300.0


def provider_for(which: str) -> Provider:
    """Proveedor del subcomando de la CLI."""
    if which == "google":
        return google_provider()
    raise ValueError(f"proveedor desconocido: {which!r}")


def sign_in(provider: Provider, store: TokenStore, name: str, *,
            browser: Callable[[str], object] = webbrowser.open,
            out: Callable[[str], object] = print) -> TokenSet | None:
    """Reusa los tokens del disco o corre el flujo del loopback y los guarda.

    Devuelve None si los tokens guardados estaban revocados: en ese caso los
    borra y pide volver a correr. Imprime si reuso el sign-in (la prueba de PC de
    que sobrevive a un reinicio). `name` es la clave bajo la que se guardan: el
    conector usa el nombre del proveedor, `bench` usa `bench-<proveedor>`.
    """
    tokens = store.load(name)
    if tokens is not None:
        out(f"Sign-in: reused from disk ({name})")
        if tokens.expired():
            with httpx.Client(timeout=30.0) as client:
                try:
                    tokens = refresh(client, provider, tokens)
                except InvalidGrant:
                    store.delete(name)
                    out("Sign-in: the stored tokens were revoked; "
                        "run the command again to sign in.")
                    return None
            store.save(name, tokens)
            out("Sign-in: access token refreshed")
        return tokens

    out(f"Sign-in: no tokens on disk, opening the browser ({name})")
    with LoopbackReceiver(provider.redirect_host) as receiver:
        redirect_uri = receiver.redirect_uri or receiver.start()
        verifier, challenge = new_pkce()
        state = new_state()
        url = authorize_url(provider, redirect_uri, state, challenge)
        out(url)
        browser(url)
        code = receiver.wait(state, timeout=SIGN_IN_TIMEOUT)
    with httpx.Client(timeout=30.0) as client:
        tokens = exchange_code(client, provider, code, verifier, redirect_uri)
    store.save(name, tokens)
    out(f"Sign-in: new tokens saved ({name})")
    return tokens


# --------------------------------------------------------------------- ConnectFlow
def _sign_in_message(exc: BaseException) -> str:
    """Mensaje humano para la UI. Nunca incluye el `code` ni los tokens."""
    if isinstance(exc, SignInTimeout):
        return "Timed out waiting for the browser"
    if isinstance(exc, SignInCancelled):
        return "Sign-in was cancelled"
    return "Sign-in failed"


class ConnectFlow:
    """Corre el sign-in por loopback en segundo plano, para la UI.

    La CLI usa `sign_in`, que bloquea hasta que el usuario vuelve; la pantalla
    de conexion no puede quedarse esperando. Esto expone `start`/`status`/
    `cancel` con un lock: el thread de fondo espera el code, lo canjea y guarda
    los tokens igual que la CLI, bajo `provider.name` (el nombre que despues usa
    `drive_storage_from_env`).

    Un `start` nuevo cancela el flujo anterior: solo el ultimo manda sobre el
    estado, asi un redirect viejo no puede pisar al nuevo.
    """

    def __init__(
            self, store: TokenStore, *,
            provider_factory: Callable[[str], Provider] = provider_for,
            browser: Callable[[str], object] = webbrowser.open,
            client_factory: Callable[[], httpx.Client] =
            lambda: httpx.Client(timeout=30.0),
            on_connected: Callable[[str], None] | None = None,
            timeout: float = SIGN_IN_TIMEOUT) -> None:
        self.store = store
        self._provider_factory = provider_factory
        self._browser = browser
        self._client_factory = client_factory
        self._on_connected = on_connected
        self._timeout = timeout
        self._lock = threading.Lock()
        self._state = "idle"
        self._provider: str | None = None
        self._error: str | None = None
        self._receiver: LoopbackReceiver | None = None
        self._cancel = threading.Event()
        self._generation = 0

    def start(self, provider_id: str) -> str:
        """Abre el loopback, arma la URL, lanza el thread y devuelve la URL.

        `OAuthNotConfigured` sube tal cual: sin client id no hay nada que
        abrir. Los fallos del navegador solo se loguean: la UI tambien recibe
        la URL y puede abrirla ella misma.
        """
        provider = self._provider_factory(provider_id)
        with self._lock:
            self._cancel_flow()
            receiver = LoopbackReceiver(provider.redirect_host)
            redirect_uri = receiver.start()
            verifier, challenge = new_pkce()
            state = new_state()
            url = authorize_url(provider, redirect_uri, state, challenge)
            self._generation += 1
            generation = self._generation
            cancel = threading.Event()
            self._receiver = receiver
            self._cancel = cancel
            self._state = "pending"
            self._provider = provider_id
            self._error = None
            thread = threading.Thread(
                target=self._run,
                args=(provider, provider_id, receiver, state, verifier,
                      redirect_uri, generation, cancel),
                daemon=True)
            thread.start()
        try:
            self._browser(url)
        except Exception as exc:
            log.warning("no se pudo abrir el navegador: %s", exc)
        return url

    def status(self) -> dict:
        """`{state, provider, error}`: lo que la UI necesita para pintarse."""
        with self._lock:
            return {"state": self._state, "provider": self._provider,
                    "error": self._error}

    def cancel(self) -> None:
        """Cancela el flujo en curso. Si no hay ninguno, no hace nada."""
        with self._lock:
            if not self._cancel_flow():
                return
            self._state = "cancelled"
            self._error = None

    def _cancel_flow(self) -> bool:
        """Cierra el receptor y despierta al thread. Dice si habia flujo.

        No toca el estado: `start` lo pasa a `pending` y `cancel` a
        `cancelled`. Bajo el lock.
        """
        receiver = self._receiver
        self._receiver = None
        if receiver is None:
            return False
        self._cancel.set()
        receiver.cancel()
        return True

    def _run(self, provider: Provider, provider_id: str,
             receiver: LoopbackReceiver, state: str, verifier: str,
             redirect_uri: str, generation: int,
             cancel: threading.Event) -> None:
        """Thread de fondo: espera el code, lo canjea y guarda los tokens."""
        try:
            code = receiver.wait(state, timeout=self._timeout)
        except OAuthError as exc:
            if not cancel.is_set():
                self._finish(generation, "error", _sign_in_message(exc))
            return
        finally:
            receiver.close()
        if cancel.is_set():
            return
        try:
            with self._client_factory() as client:
                tokens = exchange_code(client, provider, code, verifier,
                                       redirect_uri)
        except Exception as exc:
            if not cancel.is_set():
                self._finish(generation, "error", _sign_in_message(exc))
            return
        if cancel.is_set():
            return
        try:
            self.store.save(provider.name, tokens)
        except Exception as exc:
            log.warning("no se pudieron guardar los tokens: %s", exc)
            if not cancel.is_set():
                self._finish(generation, "error", _sign_in_message(exc))
            return
        if self._on_connected is not None:
            try:
                self._on_connected(provider_id)
            except Exception:
                # El flujo ya esta conectado: un fallo de la UI no lo tumba.
                log.exception("on_connected fallo")
        self._finish(generation, "connected", None)

    def _finish(self, generation: int, state: str, error: str | None) -> None:
        """Fija el estado final, salvo que un `start` mas nuevo lo haya pisado."""
        with self._lock:
            if generation != self._generation:
                return
            self._state = state
            self._error = error

    # ------------------------------------------------ consultas y desconexion
    def is_connected(self, provider_id: str) -> bool:
        """Si el proveedor tiene tokens guardados (lo mismo que `is_connected`).

        Un flujo que no es este (Android) contesta distinto: por eso `main` le
        pregunta al flujo y no mira `flow.store`.
        """
        return is_connected(self.store, provider_id)

    def disconnect(self, provider_id: str) -> None:
        """Borra los tokens guardados del proveedor (no toca el ajuste activo)."""
        disconnect(self.store, provider_id)


def is_connected(store: TokenStore, provider_id: str) -> bool:
    """True si hay tokens guardados para el proveedor. False si no esta config."""
    try:
        provider = provider_for(provider_id)
    except (OAuthNotConfigured, ValueError):
        return False
    return store.load(provider.name) is not None


def disconnect(store: TokenStore, provider_id: str) -> None:
    """Borra los tokens guardados del proveedor (no toca el ajuste activo)."""
    store.delete(provider_for(provider_id).name)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m backend.app.cloud.connect",
        description="Conecta (o desconecta) un proveedor de nube en la PC.")
    parser.add_argument("provider", choices=("google",),
                        help="proveedor a conectar")
    parser.add_argument("--disconnect", action="store_true",
                        help="borra los tokens guardados y no hace sign-in")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        provider = provider_for(args.provider)
    except (OAuthNotConfigured, ValueError) as exc:
        print(f"[connect] {exc}", file=sys.stderr)
        return 2

    store = TokenStore(default_token_dir(), default_protector())
    if args.disconnect:
        store.delete(provider.name)
        print(f"Disconnected {provider.name}")
        return 0

    try:
        tokens = sign_in(provider, store, provider.name)
    except (OAuthError, OAuthNotConfigured) as exc:
        print(f"[connect] {exc}", file=sys.stderr)
        return 2
    if tokens is None:
        return 2
    print(f"Connected {provider.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
