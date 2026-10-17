"""Tests OFFLINE del ajuste de almacenamiento activo (cloud/settings.py).

El valor que escribe la pantalla de conexion vive en `<data_dir>/storage.json`.
Todo con `SPITIFO_DATA_DIR` en un temporal: nunca se toca el directorio real
del usuario.
"""
from __future__ import annotations

import json

import pytest

from backend.app.cloud import settings
from backend.app.storage import get_storage, reset_storage, set_storage


@pytest.fixture(autouse=True)
def aislado(monkeypatch, tmp_path):
    """Directorio de datos temporal y sin variables que ensucien el default."""
    monkeypatch.setenv("SPITIFO_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("SPITIFO_STORAGE", raising=False)
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("SPITIFO_GOOGLE_CLIENT_SECRET", raising=False)
    yield
    set_storage(None)


# ------------------------------------------------------------------- el ajuste
def test_default_es_local(tmp_path):
    assert settings.active_storage(tmp_path) == "local"


def test_round_trip(tmp_path):
    settings.set_active_storage("google", tmp_path)
    assert settings.active_storage(tmp_path) == "google"
    settings.set_active_storage("local", tmp_path)
    assert settings.active_storage(tmp_path) == "local"


def test_archivo_corrupto_es_local(tmp_path):
    (tmp_path / "storage.json").write_text("{ esto no es json", encoding="utf-8")
    assert settings.active_storage(tmp_path) == "local"


def test_valor_desconocido_en_archivo_es_local(tmp_path):
    (tmp_path / "storage.json").write_text(
        json.dumps({"active": "dropbox"}), encoding="utf-8")
    assert settings.active_storage(tmp_path) == "local"


def test_escribir_valor_desconocido_falla(tmp_path):
    with pytest.raises(ValueError):
        settings.set_active_storage("dropbox", tmp_path)
    # No quedo ningun archivo a medias.
    assert not (tmp_path / "storage.json").exists()


def test_set_usa_el_directorio_de_datos_por_defecto(tmp_path):
    settings.set_active_storage("google")
    assert (tmp_path / "storage.json").is_file()
    assert settings.active_storage() == "google"


# ---------------------------------------------------------------- get_storage
def test_get_storage_usa_el_ajuste(monkeypatch, tmp_path):
    """Sin env, el ajuste manda: `google` arma el adapter de Drive."""
    settings.set_active_storage("google", tmp_path)
    monkeypatch.setattr("backend.app.cloud.drive.drive_storage_from_env",
                        lambda: "DRIVE")
    assert get_storage() == "DRIVE"


def test_env_gana_sobre_el_ajuste(monkeypatch, tmp_path):
    """El ajuste dice local (default) pero el env pide Drive."""
    monkeypatch.setenv("SPITIFO_STORAGE", "google")
    monkeypatch.setattr("backend.app.cloud.drive.drive_storage_from_env",
                        lambda: "DRIVE")
    assert get_storage() == "DRIVE"


def test_env_desconocido_falla(monkeypatch):
    monkeypatch.setenv("SPITIFO_STORAGE", "dropbox")
    with pytest.raises(ValueError):
        get_storage()


def test_google_sin_config_cae_a_local(monkeypatch, tmp_path):
    """El ajuste pide Drive pero falta el cliente OAuth: la app arranca igual."""
    from backend.app.cloud.oauth import OAuthNotConfigured
    from backend.app.storage.local import LocalStorage

    settings.set_active_storage("google", tmp_path)

    def _sin_config():
        raise OAuthNotConfigured("falta SPITIFO_GOOGLE_CLIENT_ID")

    monkeypatch.setattr("backend.app.cloud.drive.drive_storage_from_env",
                        _sin_config)
    assert isinstance(get_storage(), LocalStorage)


def test_reset_storage_rearma_el_adapter(monkeypatch):
    from backend.app.storage.local import LocalStorage

    primera = get_storage()
    assert isinstance(primera, LocalStorage)
    reset_storage()
    assert get_storage() is not primera
