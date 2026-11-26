"""Cache-Control del frontend compilado (`_FrontendStaticFiles`).

Los chunks de Vite bajo `assets/` llevan el hash en el nombre: cache
inmutable de un ano es seguro. `index.html` nunca se cachea. El resto
(genre-map.json, favicon) usa un max-age corto. Arma su propia app Starlette
con una carpeta temporal: no depende de `SPITIFO_FRONTEND_DIST` ni del orden
de import de `backend.app.main` (el mount real se arma una sola vez, al
importar el modulo).
"""
from __future__ import annotations

import pytest
from starlette.applications import Starlette
from starlette.routing import Mount
from starlette.testclient import TestClient

from backend.app.main import _FrontendStaticFiles


@pytest.fixture
def frontend_client(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "index-abc123.js").write_text("console.log(1)")
    (tmp_path / "index.html").write_text("<html></html>")
    (tmp_path / "genre-map.json").write_text("{}")
    app = Starlette(routes=[
        Mount("/", _FrontendStaticFiles(directory=tmp_path, html=True),
              name="frontend"),
    ])
    with TestClient(app) as c:
        yield c


def test_chunk_con_hash_lleva_cache_inmutable_de_un_ano(frontend_client):
    r = frontend_client.get("/assets/index-abc123.js")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_index_html_nunca_se_cachea(frontend_client):
    r = frontend_client.get("/")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache"


def test_el_resto_lleva_un_max_age_corto(frontend_client):
    r = frontend_client.get("/genre-map.json")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "public, max-age=3600"
