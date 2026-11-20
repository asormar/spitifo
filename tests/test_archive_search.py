"""Busqueda en Internet Archive: que consultas se hacen y que se devuelve.

OFFLINE: archive.org simulado con MockTransport, que contesta segun la
coleccion que pide cada consulta.
"""
from __future__ import annotations

import asyncio

import httpx

from backend.app.sources import InternetArchiveSource

RADIO = [{"identifier": f"radio{i}", "title": f"KCSB 91.9 FM : April {i}, 2019 07:00AM-08:00AM PDT"}
         for i in range(12)]
BLUES = [{"identifier": f"blues{i}", "title": f"Delta Blues Session {i}", "creator": "Sonny Band"}
         for i in range(6)]
FOLK = [{"identifier": f"folk{i}", "title": f"Blues for the Road {i}", "creator": "Folk Trio"}
        for i in range(4)]


def _fuente(docs_por_coleccion, fallar=()):
    pedidas: list[str] = []

    def responder(request: httpx.Request) -> httpx.Response:
        q = request.url.params["q"]
        pedidas.append(q)
        if "audio_music" in q:
            col = "audio_music"
        elif "opensource_audio" in q:
            col = "opensource_audio"
        elif " OR " in q:
            col = "loose"
        else:
            col = "plain"
        if col in fallar:
            return httpx.Response(503)
        rows = int(request.url.params["rows"])
        return httpx.Response(200, json={"response": {"docs": docs_por_coleccion.get(col, [])[:rows]}})

    src = InternetArchiveSource()
    src._client = httpx.AsyncClient(transport=httpx.MockTransport(responder))
    return src, pedidas


def _buscar(src, q, limit=12):
    return asyncio.run(src.search(q, limit))


def test_la_radio_de_la_consulta_general_no_tapa_las_colecciones_de_musica():
    """Antes: la general traia 12 programas de radio, la busqueda paraba ahi y
    el filtro los tiraba todos. Resultado: 0 para "blues"."""
    src, _ = _fuente({"plain": RADIO, "audio_music": BLUES, "opensource_audio": FOLK})
    out = _buscar(src, "blues")
    ids = {t.source_id for t in out}
    assert ids == {f"blues{i}" for i in range(6)} | {f"folk{i}" for i in range(4)}
    assert all(t.extra["match_query"] == "blues" for t in out)


def test_las_tres_consultas_estrictas_salen_siempre():
    src, pedidas = _fuente({"plain": BLUES * 3})
    _buscar(src, "blues", limit=4)
    assert sum(" OR " not in q for q in pedidas) == 3


def test_sin_suficientes_resultados_prueba_la_consulta_relajada():
    loose = [{"identifier": "numb", "title": "Numb", "creator": "Linkin Park"}]
    src, pedidas = _fuente({"loose": loose})
    out = _buscar(src, "linkin park numb")
    assert [t.source_id for t in out] == ["numb"]
    assert any(" OR " in q for q in pedidas)


def test_con_resultados_de_sobra_no_hace_la_relajada():
    src, pedidas = _fuente({"audio_music": BLUES, "opensource_audio": FOLK})
    _buscar(src, "blues", limit=8)
    assert not any(" OR " in q for q in pedidas)


def test_un_item_repetido_en_dos_colecciones_sale_una_vez():
    src, _ = _fuente({"plain": BLUES[:2], "audio_music": BLUES[:2]})
    out = _buscar(src, "blues", limit=2)
    assert sorted(t.source_id for t in out) == ["blues0", "blues1"]


def test_si_falla_una_coleccion_quedan_las_otras():
    src, _ = _fuente({"plain": RADIO, "audio_music": BLUES}, fallar=("opensource_audio",))
    out = _buscar(src, "blues", limit=6)
    assert {t.source_id for t in out} == {f"blues{i}" for i in range(6)}


def test_si_fallan_todas_las_estrictas_se_levanta_el_error():
    src, _ = _fuente({}, fallar=("plain", "audio_music", "opensource_audio"))
    try:
        _buscar(src, "blues")
    except httpx.HTTPStatusError:
        pass
    else:
        raise AssertionError("tenia que levantar el error de archive")
