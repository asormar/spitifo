"""Middleware ASGI del secreto por lanzamiento.

En Android cualquier app del teléfono puede conectarse a `127.0.0.1`, y este
backend va a guardar los tokens de la nube del usuario. Por eso el shell genera
un secreto random en cada lanzamiento, lo pasa en `SPITIFO_TOKEN` y el backend
rechaza todo lo que no lo traiga (ver `docs/adr/0002-user-owned-storage.md`,
nota de seguridad de la sesión 3).

El middleware es ASGI puro (no `BaseHTTPMiddleware`) para que las respuestas
grandes y los streams de `/api/audio` no pasen por una capa que los bufferee.

El token se recibe como parámetro (no se lee del entorno acá) para que main.py
lo cablee y los tests puedan construir una app a medida sin contaminar el
entorno del resto de la suite.
"""
from __future__ import annotations

import hmac
from http.cookies import SimpleCookie
from urllib.parse import urlencode

from starlette.datastructures import Headers, QueryParams
from starlette.responses import JSONResponse, PlainTextResponse, RedirectResponse

COOKIE_NAME = "spitifo_session"
HEADER_NAME = "x-spitifo-token"  # el shell manda X-Spitifo-Token
TOKEN_PARAM = "token"


def _same(candidate: str | None, token: str) -> bool:
    """Comparación en tiempo constante, en bytes (admite tokens no-ASCII)."""
    if candidate is None:
        return False
    return hmac.compare_digest(candidate.encode("utf-8"), token.encode("utf-8"))


def _session_cookie(headers: Headers) -> str | None:
    raw = headers.get("cookie")
    if not raw:
        return None
    jar = SimpleCookie()
    try:
        jar.load(raw)
    except Exception:
        return None
    morsel = jar.get(COOKIE_NAME)
    return morsel.value if morsel else None


class TokenAuthMiddleware:
    """Exige el secreto por cookie o header; sin token configurado es un no-op."""

    def __init__(self, app, token: str | None) -> None:
        self.app = app
        self.token = token or ""

    async def __call__(self, scope, receive, send) -> None:
        # Lifespan y websockets pasan sin tocar: el secreto protege HTTP.
        if scope["type"] != "http" or not self.token:
            await self.app(scope, receive, send)
            return

        query = QueryParams(scope.get("query_string", b""))
        if query.get(TOKEN_PARAM) is not None:
            # Bootstrap del WebView: el shell carga /?token=<secreto> UNA vez,
            # se le deja la cookie y sigue con la URL ya limpia.
            if _same(query.get(TOKEN_PARAM), self.token):
                await self._bootstrap(scope, receive, send, query)
            else:
                await self._deny(scope, receive, send)
            return

        headers = Headers(scope=scope)
        if (_same(headers.get(HEADER_NAME), self.token)
                or _same(_session_cookie(headers), self.token)):
            await self.app(scope, receive, send)
            return

        await self._deny(scope, receive, send)

    async def _bootstrap(self, scope, receive, send, query: QueryParams) -> None:
        # Se conserva el resto de los query params; solo se saca `token`.
        resto = [(k, v) for k, v in query.multi_items() if k != TOKEN_PARAM]
        qs = urlencode(resto)
        location = scope.get("path", "/") + (f"?{qs}" if qs else "")
        response = RedirectResponse(location, status_code=303)
        response.set_cookie(COOKIE_NAME, self.token, httponly=True,
                            samesite="strict", path="/")
        await response(scope, receive, send)

    async def _deny(self, scope, receive, send) -> None:
        if scope.get("path", "").startswith("/api"):
            response = JSONResponse({"detail": "unauthorized"}, status_code=401)
        else:
            response = PlainTextResponse("unauthorized", status_code=401)
        await response(scope, receive, send)
