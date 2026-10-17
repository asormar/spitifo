"""Guardado de tokens OAuth, protegidos por el SO (ADR 0002, seccion 3).

Un archivo por proveedor dentro del directorio de datos del usuario. En Windows
los bytes van cifrados con DPAPI en el ambito del usuario actual; en el resto,
un `PlainProtector` de identidad. En Android, Kotlin pasara el token ya cifrado
por el Android Keystore en un paso posterior: hasta entonces aca no hay
proteccion real del SO (por eso `PlainProtector` es explicito, no un olvido).

Modulo neutral: no importa starlette ni uvicorn.
"""
from __future__ import annotations

import ctypes
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Protocol

from .oauth import TokenSet


class Protector(Protocol):
    """Transforma los bytes guardados en disco. Ida y vuelta."""

    def protect(self, data: bytes) -> bytes: ...

    def unprotect(self, data: bytes) -> bytes: ...


class PlainProtector:
    """Identidad: no protege nada.

    Solo se usa donde el SO todavia no ofrece nada. En Android, el ciphertext
    con la clave del Keystore llega desde Kotlin mas adelante, no desde aca.
    """

    def protect(self, data: bytes) -> bytes:
        return data

    def unprotect(self, data: bytes) -> bytes:
        return data


class _DataBlob(ctypes.Structure):
    _fields_ = [
        ("cbData", ctypes.c_uint32),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


#: Sin UI: DPAPI no puede mostrar un dialogo desde un proceso de fondo.
_UI_FORBIDDEN = 0x1
_API: dict = {}


def _api():
    """Carga crypt32/kernel32 una vez y fija las firmas (necesario en 64 bits)."""
    if not _API:
        crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        pb = ctypes.POINTER(_DataBlob)
        crypt32.CryptProtectData.argtypes = [
            pb, ctypes.c_wchar_p, pb, ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_uint32, pb]
        crypt32.CryptProtectData.restype = ctypes.c_int
        crypt32.CryptUnprotectData.argtypes = [
            pb, ctypes.c_void_p, pb, ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_uint32, pb]
        crypt32.CryptUnprotectData.restype = ctypes.c_int
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        _API["crypt32"] = crypt32
        _API["kernel32"] = kernel32
    return _API["crypt32"], _API["kernel32"]


def _in_blob(data: bytes):
    """DATA_BLOB de entrada. El buffer se devuelve para mantenerlo vivo."""
    buf = ctypes.create_string_buffer(bytes(data), max(1, len(data)))
    blob = _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    return blob, buf


class DpapiProtector:
    """Cifrado con DPAPI en el ambito del usuario actual (solo Windows)."""

    def protect(self, data: bytes) -> bytes:
        crypt32, _ = _api()
        blob_in, _buf = _in_blob(data)
        blob_out = _DataBlob()
        ok = crypt32.CryptProtectData(
            ctypes.byref(blob_in), None, None, None, None, _UI_FORBIDDEN,
            ctypes.byref(blob_out))
        if not ok:
            raise OSError(ctypes.get_last_error(), "CryptProtectData fallo")
        try:
            return ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            _api()[1].LocalFree(ctypes.cast(blob_out.pbData, ctypes.c_void_p))

    def unprotect(self, data: bytes) -> bytes:
        crypt32, kernel32 = _api()
        blob_in, _buf = _in_blob(data)
        blob_out = _DataBlob()
        ok = crypt32.CryptUnprotectData(
            ctypes.byref(blob_in), None, None, None, None, _UI_FORBIDDEN,
            ctypes.byref(blob_out))
        if not ok:
            raise OSError(ctypes.get_last_error(), "CryptUnprotectData fallo")
        try:
            return ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            kernel32.LocalFree(ctypes.cast(blob_out.pbData, ctypes.c_void_p))


def default_protector() -> Protector:
    """DPAPI donde existe; identidad en el resto hasta que el SO lo resuelva."""
    if sys.platform == "win32":
        return DpapiProtector()
    return PlainProtector()


def default_token_dir() -> Path:
    """Directorio de tokens del usuario, segun el SO."""
    override = os.getenv("SPITIFO_DATA_DIR")
    if override:
        return Path(override) / "tokens"
    if sys.platform == "win32":
        local = os.getenv("LOCALAPPDATA")
        if local:
            return Path(local) / "Spitifo" / "tokens"
    return Path.home() / ".local" / "share" / "spitifo" / "tokens"


#: El nombre del proveedor termina en un nombre de archivo: tiene que ser seguro.
_SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


class TokenStore:
    """Un archivo por proveedor, escrito de forma atomica."""

    def __init__(self, directory: Path, protector: Protector | None = None) -> None:
        self.directory = Path(directory)
        self.protector = protector or default_protector()

    def _path(self, provider_name: str) -> Path:
        if not _SAFE_NAME.match(provider_name) or provider_name in (".", ".."):
            raise ValueError(f"nombre de proveedor invalido: {provider_name!r}")
        return self.directory / f"{provider_name}.bin"

    def load(self, provider_name: str) -> TokenSet | None:
        """Tokens guardados, o None si no hay o no se pueden descifrar."""
        # El nombre invalido es error de programacion: no se silencia.
        path = self._path(provider_name)
        try:
            raw = path.read_bytes()
            data = json.loads(self.protector.unprotect(raw).decode("utf-8"))
            return TokenSet.from_dict(data)
        except Exception:
            # No existe, esta corrupto, o DPAPI no lo puede descifrar (otra
            # cuenta de Windows): se trata como "sin token" y la UI reconecta.
            return None

    def save(self, provider_name: str, tokens: TokenSet) -> None:
        """Escribe atomico: temporal en el mismo dir + `os.replace`."""
        path = self._path(provider_name)
        self.directory.mkdir(parents=True, exist_ok=True)
        raw = self.protector.protect(
            json.dumps(tokens.to_dict()).encode("utf-8"))
        fd, tmp = tempfile.mkstemp(dir=self.directory, prefix=".tokens-",
                                   suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(raw)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def delete(self, provider_name: str) -> None:
        try:
            self._path(provider_name).unlink()
        except FileNotFoundError:
            pass
