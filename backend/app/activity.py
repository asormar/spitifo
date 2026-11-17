"""Contador de actividad: avisa cuando hay trabajo de descarga en curso.

Existe por el shell de Android. Android corta la red de la app apenas se apaga
la pantalla salvo que haya un foreground service corriendo; para no dejarlo
vivo de mas, el shell necesita saber cuando ARRANCA el primer trabajo y cuando
TERMINA el ultimo. Este modulo es ese aviso, y nada mas: un contador (0 -> 1
llama a los listeners con True, 1 -> 0 con False) mas el context manager
`busy()` para envolver un tramo de trabajo.

Es deliberadamente NEUTRAL: no importa starlette ni uvicorn, asi que el mismo
contador sirve corriendo embebido o como server suelto. Ver
docs/adr/0001-android-embedded-python.md (seccion "Screen off").
"""
from __future__ import annotations

import logging
import threading
from contextlib import contextmanager
from typing import Callable, Iterator

log = logging.getLogger("spitifo.activity")

_lock = threading.Lock()
# Cuantos trabajos hay en curso. Nunca baja de 0.
_count = 0
# Listeners registrados. Se copian bajo el lock y se llaman FUERA de el: un
# listener puede tardar (arrancar un servicio) y no debe bloquear begin/end.
_listeners: list[Callable[[bool], None]] = []


def add_listener(fn: Callable[[bool], None]) -> None:
    """Registra `fn`, que se llama con True al arrancar y False al terminar."""
    with _lock:
        _listeners.append(fn)


def remove_listener(fn: Callable[[bool], None]) -> None:
    """Saca un listener. Si no estaba, no hace nada."""
    with _lock:
        try:
            _listeners.remove(fn)
        except ValueError:
            pass


def _notify(activo: bool) -> None:
    """Llama a los listeners fuera del lock; un listener roto no propaga."""
    with _lock:
        oyentes = list(_listeners)
    for fn in oyentes:
        try:
            fn(activo)
        except Exception:
            # El aviso es best-effort: el shell no puede tumbar la descarga.
            log.exception("listener de actividad fallo (activo=%s)", activo)


def begin() -> None:
    """Marca el inicio de un trabajo. Avisa solo en la transicion 0 -> 1."""
    global _count
    with _lock:
        _count += 1
        arranca = _count == 1
    if arranca:
        _notify(True)


def end() -> None:
    """Marca el fin de un trabajo. Avisa solo en la transicion 1 -> 0."""
    global _count
    with _lock:
        if _count == 0:
            return  # no baja de 0: un end de mas es un no-op
        _count -= 1
        termina = _count == 0
    if termina:
        _notify(False)


@contextmanager
def busy() -> Iterator[None]:
    """Envuelve un tramo de trabajo: begin() al entrar, end() al salir.

    `end()` corre tambien si el bloque lanza, asi que el contador nunca queda
    colgado por una excepcion.
    """
    begin()
    try:
        yield
    finally:
        end()


def is_busy() -> bool:
    """True si hay al menos un trabajo en curso."""
    with _lock:
        return _count > 0


# ------------------------------------------------------------ archivos borrados
# Segundo aviso, aparte del contador: la biblioteca borro archivos. El shell de
# Android lo necesita para sacarlos del MediaStore; no arranca ningun servicio,
# por eso no pasa por begin/end (eso mostraria la notificacion de descarga).
_removed_listeners: list[Callable[[list[str]], None]] = []


def add_removed_listener(fn: Callable[[list[str]], None]) -> None:
    """Registra `fn`, que recibe las claves que la biblioteca acaba de borrar."""
    with _lock:
        _removed_listeners.append(fn)


def removed(keys: list[str]) -> None:
    """Avisa de claves borradas. Best-effort: un listener roto no propaga."""
    if not keys:
        return
    with _lock:
        oyentes = list(_removed_listeners)
    for fn in oyentes:
        try:
            fn(list(keys))
        except Exception:
            log.exception("listener de borrados fallo")
