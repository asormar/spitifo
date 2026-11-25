"""Executors acotados para yt-dlp y para storage/archivo.

Antes TODO `loop.run_in_executor(None, ...)` / `asyncio.to_thread(...)` del
proceso comparte el mismo `ThreadPoolExecutor` por defecto de asyncio
(`min(32, cpu_count()+4)` hilos): una extraccion de yt-dlp lenta (busqueda,
resolve, descarga) podia dejar sin hilos libres una lectura de `/api/audio`, y
una tanda de lecturas de biblioteca podia demorar un play. Con dos pools
chicos y separados, lo uno nunca le saca hilos a lo otro.

Tamanos pensados para el telefono de referencia (4-8 nucleos, 4 GB de RAM), NO
para el PC de desarrollo:

- `YTDLP_EXECUTOR` (8 hilos): 3 cubren el pool de busqueda (`_SEARCH_POOL` en
  ytdlp_source.py, como mucho 3 instancias de `YoutubeDL` vivas a la vez), 4
  cubren `downloads.MAX_NETWORK` (hasta 4 descargas en vuelo: la fase de red
  separada del limite de 2 transcodificaciones de CPU, P-downloads-pipeline-1;
  cada una ocupa su hilo por la descarga COMPLETA: yt-dlp baja el archivo
  adentro de la misma llamada que extrae, no en dos pasos) y el octavo es el
  margen para que un resolve de un toque del usuario (tocar play) nunca haga
  cola detras de una racha de busquedas de 3 MAS las 4 descargas de fondo que
  ya pudieran estar corriendo. Cada hilo sostiene como mucho una instancia de
  `YoutubeDL` (certificados, una conexion TLS): 8 hilos pesan unos pocos MB,
  por debajo de lo que reservaria el default de asyncio en el telefono
  (cpu_count()+4, o sea entre 8 y 12 hilos, cada uno pudiendo abrir SU PROPIA
  instancia si no hubiera pool).
- `STORAGE_EXECUTOR` (6 hilos): alcanza para un `library_scan` completo mas un
  par de lecturas de rango de `/api/audio` (los saltos dentro de un tema) mas
  el guardado atomico de la cola de descargas, sin que unas esperen a otras y
  sin acercarse a un numero de hilos que pese en 4 GB de RAM.
- `PREFETCH_EXECUTOR` (2 hilos): el adelanto de la proxima pista (auto-advance)
  es trabajo de fondo descartable, nunca critico. Un pool PROPIO, chico y
  separado de `STORAGE_EXECUTOR`, evita que una racha de saltos rapidos (cada
  uno encola un prefetch que puede tardar segundos en Drive) le saque hilos a
  una lectura de `/api/audio` o al guardado de la cola — exactamente el tipo
  de contencion que este modulo existe para evitar en primer lugar.

Ninguno de los tres compite con los otros NI con el default de asyncio (que
sigue sirviendo el resto de las rutas: playlists, guardadas, portadas,
cookies...).
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Any, Callable, TypeVar

T = TypeVar("T")

#: Ver el modulo para la cuenta completa de por que estos numeros.
YTDLP_WORKERS = 8
STORAGE_WORKERS = 6
PREFETCH_WORKERS = 2

YTDLP_EXECUTOR = ThreadPoolExecutor(
    max_workers=YTDLP_WORKERS, thread_name_prefix="ytdlp")
STORAGE_EXECUTOR = ThreadPoolExecutor(
    max_workers=STORAGE_WORKERS, thread_name_prefix="storage")
PREFETCH_EXECUTOR = ThreadPoolExecutor(
    max_workers=PREFETCH_WORKERS, thread_name_prefix="prefetch")


def run_ytdlp(func: Callable[..., T], *args: Any, **kwargs: Any) -> "asyncio.Future[T]":
    """`func(*args, **kwargs)` en el pool de yt-dlp (busqueda/resolve/descarga).

    Nunca comparte hilos con storage: una extraccion lenta no le saca un hilo
    a una lectura de `/api/audio`.
    """
    loop = asyncio.get_running_loop()
    call = partial(func, *args, **kwargs) if kwargs else func
    args_para_el_loop = () if kwargs else args
    return loop.run_in_executor(YTDLP_EXECUTOR, call, *args_para_el_loop)


def run_storage(func: Callable[..., T], *args: Any, **kwargs: Any) -> "asyncio.Future[T]":
    """`func(*args, **kwargs)` en el pool de storage/archivo."""
    loop = asyncio.get_running_loop()
    call = partial(func, *args, **kwargs) if kwargs else func
    args_para_el_loop = () if kwargs else args
    return loop.run_in_executor(STORAGE_EXECUTOR, call, *args_para_el_loop)


def run_prefetch(func: Callable[..., T], *args: Any, **kwargs: Any) -> "asyncio.Future[T]":
    """`func(*args, **kwargs)` en el pool de prefetch (adelanto de la proxima pista).

    Nunca comparte hilos con storage: una racha de saltos no le saca un hilo
    a una lectura de `/api/audio` ni al guardado de la cola.
    """
    loop = asyncio.get_running_loop()
    call = partial(func, *args, **kwargs) if kwargs else func
    args_para_el_loop = () if kwargs else args
    return loop.run_in_executor(PREFETCH_EXECUTOR, call, *args_para_el_loop)
