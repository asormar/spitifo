"""OAuth 2.0 authorization code con PKCE para apps nativas (RFC 8252, RFC 7636).

El backend en Python es dueno del flujo: genera PKCE y `state`, canjea el code,
refresca y guarda tokens. El shell solo abre el navegador y, en Android, le pasa
el redirect a Python en proceso (docs/adr/0002-user-owned-storage.md, seccion 3).

Neutral al proveedor: Google y Microsoft se describen con la misma `Provider`.
Toda salida a la red va por el `httpx.Client` que recibe cada funcion, nunca por
un cliente propio.
"""
from __future__ import annotations

import base64
import hashlib
import os
import queue
import secrets
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

# ------------------------------------------------------------------- Google
GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
#: Scope no sensible: no exige verificacion de la app (ADR 0002, seccion 1).
GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file"

# ---------------------------------------------------------------- Microsoft
MS_AUTHORIZE_URL = (
    "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize")
MS_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"
#: App Folder, no todo el Drive. `offline_access` habilita el refresh token.
MS_SCOPES = ("Files.ReadWrite.AppFolder", "offline_access")


class OAuthError(RuntimeError):
    """Fallo del flujo que la UI no puede resolver sola."""


class InvalidGrant(OAuthError):
    """El token quedo revocado: la UI ofrece "Reconnect <provider>"."""


class OAuthNotConfigured(RuntimeError):
    """Falta el client id/secret en el entorno."""


@dataclass(frozen=True)
class Provider:
    """Todo lo que distingue a un proveedor de otro en el flujo OAuth."""

    name: str
    authorize_url: str
    token_url: str
    client_id: str
    client_secret: str | None
    scopes: tuple[str, ...]
    extra_authorize_params: dict[str, str] = field(default_factory=dict)
    #: Host del redirect de loopback. Google acepta cualquier puerto en
    #: `127.0.0.1`; Microsoft ignora el puerto solo con `localhost`, asi que
    #: ahi se registra `http://localhost/callback`.
    redirect_host: str = "127.0.0.1"


def _env(name: str) -> str:
    """Lee una variable de entorno o falla nombrando la que falta."""
    value = os.getenv(name)
    if not value:
        raise OAuthNotConfigured(f"falta la variable de entorno {name}")
    return value


def google_provider() -> Provider:
    """Cliente de escritorio de Google: id + secret, scope `drive.file`."""
    return Provider(
        name="google",
        authorize_url=GOOGLE_AUTHORIZE_URL,
        token_url=GOOGLE_TOKEN_URL,
        client_id=_env("SPITIFO_GOOGLE_CLIENT_ID"),
        client_secret=_env("SPITIFO_GOOGLE_CLIENT_SECRET"),
        scopes=(GOOGLE_SCOPE,),
        # `access_type=offline` pide refresh token; `prompt=consent` fuerza a
        # que Google lo entregue tambien en reconexiones.
        extra_authorize_params={"access_type": "offline", "prompt": "consent"},
    )


def microsoft_provider() -> Provider:
    """Cliente publico de Microsoft: sin secret, app folder de OneDrive."""
    return Provider(
        name="microsoft",
        authorize_url=MS_AUTHORIZE_URL,
        token_url=MS_TOKEN_URL,
        client_id=_env("SPITIFO_MS_CLIENT_ID"),
        client_secret=None,
        scopes=MS_SCOPES,
        redirect_host="localhost",
    )


# ----------------------------------------------------------------------- PKCE
def code_challenge(verifier: str) -> str:
    """Desafio S256: base64url(SHA256(verifier)) sin relleno (RFC 7636)."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def new_pkce() -> tuple[str, str]:
    """`(verifier, challenge)`. 48 bytes dan 64 caracteres url-safe."""
    verifier = secrets.token_urlsafe(48)
    return verifier, code_challenge(verifier)


def new_state() -> str:
    """Valor opaco contra CSRF: se compara al volver el redirect."""
    return secrets.token_urlsafe(32)


def authorize_url(provider: Provider, redirect_uri: str, state: str,
                  challenge: str) -> str:
    """URL de consentimiento. El shell la abre en el navegador del sistema."""
    params: dict[str, str] = {
        "response_type": "code",
        "client_id": provider.client_id,
        "redirect_uri": redirect_uri,
        "scope": " ".join(provider.scopes),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    params.update(provider.extra_authorize_params)
    return f"{provider.authorize_url}?{urlencode(params)}"


# --------------------------------------------------------------------- tokens
def _epoch(now: float | Callable[[], float] | None) -> float:
    if now is None:
        return time.time()
    if callable(now):
        return float(now())
    return float(now)


@dataclass(frozen=True)
class TokenSet:
    """Tokens vigentes. `expires_at` en segundos epoch."""

    access_token: str
    refresh_token: str | None
    expires_at: float
    scope: str = ""

    def expired(self, now: float | None = None, margin: float = 60) -> bool:
        """True si vence dentro de `margin` segundos (margen para el reloj)."""
        return _epoch(now) >= self.expires_at - margin

    def to_dict(self) -> dict:
        return {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expires_at": self.expires_at,
            "scope": self.scope,
        }

    @classmethod
    def from_dict(cls, data: dict) -> TokenSet:
        refresh = data.get("refresh_token")
        return cls(
            access_token=str(data["access_token"]),
            refresh_token=None if refresh is None else str(refresh),
            expires_at=float(data.get("expires_at", 0.0)),
            scope=str(data.get("scope", "")),
        )


def exchange_code(client: httpx.Client, provider: Provider, code: str,
                  verifier: str, redirect_uri: str,
                  now: float | None = None) -> TokenSet:
    """Canjea el `code` del redirect por el primer par de tokens."""
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": provider.client_id,
        "code_verifier": verifier,
    }
    if provider.client_secret:
        data["client_secret"] = provider.client_secret
    return _token_set(provider, _post_token(client, provider, data), now, None)


def refresh(client: httpx.Client, provider: Provider, tokens: TokenSet,
            now: float | None = None) -> TokenSet:
    """Renueva el access token con el refresh token guardado."""
    if not tokens.refresh_token:
        # Sin refresh token no hay renovacion posible: hay que reconectar.
        raise InvalidGrant(f"{provider.name}: no hay refresh token")
    data = {
        "grant_type": "refresh_token",
        "refresh_token": tokens.refresh_token or "",
        "client_id": provider.client_id,
    }
    if provider.client_secret:
        data["client_secret"] = provider.client_secret
    # Google no devuelve refresh_token al refrescar: se conserva el viejo.
    # Microsoft lo rota en cada uso: si viene, se toma el nuevo.
    return _token_set(provider, _post_token(client, provider, data), now,
                      tokens.refresh_token)


def _describe(provider: Provider, payload: dict) -> str:
    error = payload.get("error")
    desc = payload.get("error_description")
    if error and desc:
        return f"{provider.name}: {error}: {desc}"
    if error:
        return f"{provider.name}: {error}"
    if desc:
        return f"{provider.name}: {desc}"
    return ""


def _post_token(client: httpx.Client, provider: Provider, data: dict) -> dict:
    """POST al token endpoint. Traduce la respuesta a las excepciones de arriba."""
    resp = client.post(provider.token_url, data=data,
                       headers={"Accept": "application/json"})
    try:
        payload = resp.json()
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    # `invalid_grant` es el caso que la UI reconoce: no se puede resolver sin
    # que el usuario vuelva a dar consentimiento.
    if payload.get("error") == "invalid_grant":
        raise InvalidGrant(_describe(provider, payload) or "invalid_grant")
    if not 200 <= resp.status_code < 300 or payload.get("error"):
        mensaje = _describe(provider, payload) or (
            f"{provider.name}: HTTP {resp.status_code}")
        raise OAuthError(mensaje)
    return payload


def _token_set(provider: Provider, payload: dict, now, previous: str | None) -> TokenSet:
    access = payload.get("access_token")
    if not access:
        raise OAuthError(f"{provider.name}: la respuesta no trae access_token")
    try:
        expires_in = float(payload.get("expires_in", 0))
    except (TypeError, ValueError):
        expires_in = 0.0
    refresh_token = payload.get("refresh_token") or previous
    return TokenSet(
        access_token=str(access),
        refresh_token=None if not refresh_token else str(refresh_token),
        expires_at=_epoch(now) + expires_in,
        scope=str(payload.get("scope", "")),
    )


# -------------------------------------------------------------------- loopback
#: Pagina que ve el usuario en el navegador al volver del consentimiento.
_OK_PAGE = (
    "<!doctype html><html><head><meta charset=\"utf-8\">"
    "<title>Spitifo</title></head><body>"
    "<h1>Sign-in complete</h1>"
    "<p>You can close this tab and return to Spitifo.</p>"
    "</body></html>"
)


class _CallbackHandler(BaseHTTPRequestHandler):
    """Atiende el redirect del navegador en `127.0.0.1`."""

    def do_GET(self) -> None:  # noqa: N802 (nombre que exige http.server)
        receiver: LoopbackReceiver = self.server.receiver  # type: ignore[attr-defined]
        parsed = urlparse(self.path)
        if parsed.path != "/callback":
            # El navegador tambien pide /favicon.ico: no puede cerrar el flujo.
            self._answer(404, "not found")
            return
        query = parse_qs(parsed.query)
        receiver._deliver(
            error=(query.get("error") or [None])[0],
            state=(query.get("state") or [None])[0],
            code=(query.get("code") or [None])[0],
        )
        self._answer(200, _OK_PAGE)

    def _answer(self, status: int, body: str) -> None:
        payload = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args) -> None:
        # Nunca se registra la query: ahi viaja el `code`.
        pass


class LoopbackReceiver:
    """Servidor de un solo uso en `127.0.0.1` que recibe el redirect.

    RFC 8252 para apps de escritorio: la app escucha en el loopback y el SO
    elige el puerto (`port=0`). Corre en un hilo daemon. Se usa como context
    manager: `with LoopbackReceiver() as recv: ...`.
    """

    def __init__(self, host: str = "127.0.0.1") -> None:
        # El server escucha siempre en `127.0.0.1`; `host` solo cambia como se
        # escribe el redirect (`Provider.redirect_host`). Con `localhost` el
        # navegador cae a `127.0.0.1` si `::1` no responde.
        self.host = host
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._results: queue.Queue = queue.Queue()
        self.redirect_uri: str | None = None

    def start(self) -> str:
        """Levanta el server y devuelve el `redirect_uri` a usar."""
        if self._server is not None:
            assert self.redirect_uri is not None
            return self.redirect_uri
        server = ThreadingHTTPServer(("127.0.0.1", 0), _CallbackHandler)
        server.daemon_threads = True
        server.receiver = self  # type: ignore[attr-defined]
        self._server = server
        self.redirect_uri = f"http://{self.host}:{server.server_address[1]}/callback"
        self._thread = threading.Thread(target=server.serve_forever, daemon=True)
        self._thread.start()
        return self.redirect_uri

    def wait(self, expected_state: str, timeout: float) -> str:
        """Espera el redirect y devuelve el `code`. Falla si el state no coincide."""
        try:
            error, state, code = self._results.get(timeout=timeout)
        except queue.Empty:
            raise OAuthError("se agoto el tiempo esperando el redirect") from None
        if error:
            # P.ej. el usuario apreto "Cancelar": error=access_denied.
            raise OAuthError(f"el proveedor respondio error={error}")
        if state != expected_state:
            raise OAuthError("el `state` no coincide: posible CSRF")
        if not code:
            raise OAuthError("el redirect no trajo `code`")
        return code

    def _deliver(self, error: str | None, state: str | None,
                 code: str | None) -> None:
        self._results.put((error, state, code))

    def close(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def __enter__(self) -> LoopbackReceiver:
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.close()
