"""La suite nunca toca los datos ni la cuenta de nube de la persona.

El 2026-10-17 los tests de descarga subieron archivos falsos al Google Drive
real: `get_storage()` leyo el `storage.json` de la carpeta de datos verdadera.
Esto deja fijo que conftest aisla todo lo que decide el proveedor.
"""
from __future__ import annotations

from pathlib import Path

from backend.app.cloud.tokens import default_data_dir
from backend.app.storage import get_storage, set_storage
from backend.app.storage.local import LocalStorage
from conftest import DATOS_TEMPORALES, LIBRARY_TEMPORAL


def test_la_carpeta_de_datos_es_temporal():
    assert default_data_dir() == DATOS_TEMPORALES


def test_el_storage_por_defecto_es_local_y_temporal():
    set_storage(None)
    try:
        s = get_storage()
        assert isinstance(s, LocalStorage)
        assert Path(s.root) == LIBRARY_TEMPORAL
    finally:
        set_storage(None)
