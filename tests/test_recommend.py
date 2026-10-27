"""Recomendaciones de Discover: funciones puras, sin red ni storage."""
from __future__ import annotations

import math

import pytest

from backend.app.recommend import (
    artist_weights,
    candidates,
    user_genres,
)


def _library(**tracks: int) -> dict:
    """`_library(a=3, b=1)` -> `{folded: {name, tracks}}`."""
    return {name: {"name": name.upper(), "tracks": count}
            for name, count in tracks.items()}


def _record(*, genres=None, similar=None, status: str = "ok") -> dict:
    return {"name": "X", "mbid": "mx", "genres": genres or [],
            "similar": similar or [], "fetched_at": 1.0, "status": status}


def _entries(*keys: str, artist: str | None = None) -> list[dict]:
    return [{"key": key, "artist": artist} for key in keys]


# ------------------------------------------------------------------ pesos
def test_artist_weights_suma_log_y_score_de_escucha():
    library = _library(a=3, b=1)
    entries = _entries("A/A - Uno.mp3", "B/B - Dos.mp3")
    tracks = {
        "A/A - Uno.mp3": {"score": 2.0},
        # Una pista que ya no esta en la biblioteca cuenta para su artista.
        "A/A - Borrada.mp3": {"score": 1.5},
        "B/B - Dos.mp3": {"score": 0.5, "plays": 4},
        # Un artista que no esta en la biblioteca no suma.
        "Z/Z - Otro.mp3": {"score": 9.0},
        "A/A - Rota.mp3": {"score": "mucho"},
    }
    weights = artist_weights(library, entries, tracks)
    assert weights["a"] == pytest.approx(math.log1p(3) + 3.5)
    assert weights["b"] == pytest.approx(math.log1p(1) + 0.5)
    assert "z" not in weights


def test_artist_weights_usa_la_etiqueta_artist_de_la_entrada():
    # La carpeta dice "Varios" pero el tag dice el artista real.
    library = {"rosalia": {"name": "Rosalía", "tracks": 1}}
    entries = [{"key": "Varios/tema.mp3", "artist": "Rosalía"}]
    weights = artist_weights(library, entries, {"Varios/tema.mp3":
                                                {"score": 4.0}})
    assert weights["rosalia"] == pytest.approx(math.log1p(1) + 4.0)


def test_artist_weights_sin_escuchas_es_solo_log():
    library = _library(a=4)
    weights = artist_weights(library, _entries("A/A - Uno.mp3"), {})
    assert weights == {"a": pytest.approx(math.log1p(4))}


def test_artist_weights_reparte_la_escucha_de_una_colaboracion():
    library = {"bizarrap": {"name": "Bizarrap", "tracks": 1},
               "milo j": {"name": "Milo j", "tracks": 1}}
    entries = [{"key": "Varios/Bizarrap & Milo j - En la ciudad.mp3",
                "artist": "Bizarrap & Milo j"}]
    weights = artist_weights(library, entries,
                             {"Varios/Bizarrap & Milo j - En la ciudad.mp3":
                              {"score": 2.0}})
    assert weights["bizarrap"] == pytest.approx(math.log1p(1) + 2.0)
    assert weights["milo j"] == pytest.approx(math.log1p(1) + 2.0)


def test_artist_weights_reparte_la_escucha_aunque_la_pista_ya_no_este():
    library = {"bizarrap": {"name": "Bizarrap", "tracks": 1},
               "milo j": {"name": "Milo j", "tracks": 1}}
    weights = artist_weights(library, [],
                             {"Bizarrap feat. Milo j - Otra.mp3":
                              {"score": 1.5}})
    assert weights["bizarrap"] == pytest.approx(math.log1p(1) + 1.5)
    assert weights["milo j"] == pytest.approx(math.log1p(1) + 1.5)


# ----------------------------------------------------------------- generos
def test_user_genres_reparte_el_peso_y_normaliza_los_shares():
    library = _library(a=1, b=1)
    records = {
        "a": _record(genres=[["rock", 3], ["pop", 1]]),
        "b": _record(genres=[["rock", 1], ["jazz", 3]]),
    }
    weights = {"a": 1.0, "b": 1.0}
    out = user_genres(library, records, weights)
    assert [item["name"] for item in out] == ["rock", "jazz", "pop"]
    assert [item["share"] for item in out] == pytest.approx(
        [0.5, 0.375, 0.125])
    assert sum(item["share"] for item in out) == pytest.approx(1.0)


def test_user_genres_pondera_por_el_peso_del_artista():
    library = _library(a=1, b=1)
    records = {"a": _record(genres=[["rock", 1]]),
               "b": _record(genres=[["jazz", 1]])}
    out = user_genres(library, records, {"a": 3.0, "b": 1.0})
    assert [item["name"] for item in out] == ["rock", "jazz"]
    assert [item["share"] for item in out] == pytest.approx([0.75, 0.25])


def test_user_genres_acota_a_ocho_y_sin_datos_devuelve_vacio():
    library = _library(a=1)
    genres = [[f"g{i}", 10 - i] for i in range(10)]
    out = user_genres(library, {"a": _record(genres=genres)}, {"a": 1.0})
    assert len(out) == 8
    assert out[0] == {"name": "g0", "share": pytest.approx(10 / 52)}
    assert user_genres(library, {}, {"a": 1.0}) == []
    assert user_genres({}, {}, {}) == []


# --------------------------------------------------------------- candidatos
def _candidate_fixture() -> tuple[dict, dict, dict]:
    library = {"a": {"name": "A", "tracks": 1},
               "b": {"name": "B", "tracks": 1}}
    records = {
        "a": _record(similar=[
            {"name": "X", "mbid": "mx", "score": 10.0},
            {"name": "Y", "mbid": "my", "score": 5.0},
            {"name": "A", "mbid": "ma", "score": 9.0},
        ]),
        "b": _record(similar=[
            {"name": "X", "mbid": "mx", "score": 4.0},
            {"name": "Z", "mbid": "mz", "score": 8.0},
        ]),
        "x": _record(genres=[["indie", 5], ["pop", 4], ["rock", 3],
                             ["ska", 1]]),
        "y": _record(genres=[["jazz", 2]]),
    }
    weights = {"a": 2.0, "b": 1.0}
    return library, records, weights


def test_candidates_suma_aportes_y_normaliza_el_score():
    library, records, weights = _candidate_fixture()
    out = candidates(library, records, weights, dismissed=set())
    # X sale primero; despues la diversidad prefiere Z (seed B) antes que Y
    # (otra vez seed A), aunque empaten en score original.
    assert [item["name"] for item in out] == ["X", "Z", "Y"]
    assert out[0]["score"] == pytest.approx(1.0)
    assert out[1]["score"] == pytest.approx(0.4)
    assert out[2]["score"] == pytest.approx(0.4)
    assert out[0]["mbid"] == "mx"


def test_candidates_excluye_la_biblioteca_y_los_descartados():
    library, records, weights = _candidate_fixture()
    out = candidates(library, records, weights, dismissed={"y"})
    assert [item["name"] for item in out] == ["X", "Z"]
    # Descartar por nombre con acentos tambien funciona.
    assert [item["name"] for item in candidates(
        library, records, weights, dismissed={"Ý"})] == ["X", "Z"]
    assert "A" not in [item["name"] for item in out]


def test_candidates_ordena_el_because_por_aporte():
    library, records, weights = _candidate_fixture()
    out = {item["name"]: item for item in candidates(
        library, records, weights, dismissed=set())}
    # X recibe 2.0 de A y 0.5 de B; Z solo de B.
    assert out["X"]["because"] == ["A", "B"]
    assert out["Y"]["because"] == ["A"]
    assert out["Z"]["because"] == ["B"]


def test_candidates_toma_hasta_tres_generos_de_su_ficha():
    library, records, weights = _candidate_fixture()
    out = {item["name"]: item for item in candidates(
        library, records, weights, dismissed=set())}
    assert out["X"]["genres"] == ["indie", "pop", "rock"]
    assert out["Y"]["genres"] == ["jazz"]
    # Z no tiene ficha: sin generos, pero sigue siendo candidato.
    assert out["Z"]["genres"] == []


def test_candidates_acota_a_veinte_y_desempata_por_nombre():
    library = {"a": {"name": "A", "tracks": 1}}
    similar = [{"name": f"Artista {i:02d}", "mbid": f"m{i}",
                "score": 1.0} for i in range(25)]
    records = {"a": _record(similar=similar)}
    out = candidates(library, records, {"a": 1.0}, dismissed=set())
    assert len(out) == 20
    assert [item["name"] for item in out] == \
        [f"Artista {i:02d}" for i in range(20)]


def test_candidates_sin_datos_devuelve_vacio():
    assert candidates({}, {}, {}, set()) == []
    assert candidates(_library(a=1), {}, {"a": 1.0}, set()) == []
    # Una lista de similares sin scores validos no inventa candidatos.
    records = {"a": _record(similar=[{"name": "X", "mbid": "mx",
                                      "score": 0}])}
    assert candidates(_library(a=1), records, {"a": 1.0}, set()) == []


def test_candidates_no_duplica_un_similar_repetido():
    library = {"a": {"name": "A", "tracks": 1}}
    records = {"a": _record(similar=[
        {"name": "X", "mbid": "mx", "score": 1.0},
        {"name": "X", "mbid": "mx", "score": 1.0},
    ])}
    out = candidates(library, records, {"a": 1.0}, set())
    assert len(out) == 1
    assert out[0]["score"] == pytest.approx(1.0)


def test_candidates_diversifica_los_seeds_que_se_solapan():
    library = {
        "linkin park": {"name": "Linkin Park", "tracks": 1},
        "korn": {"name": "Korn", "tracks": 1},
        "slipknot": {"name": "Slipknot", "tracks": 1},
        "don omar": {"name": "Don Omar", "tracks": 1},
    }
    overlapping = [{"name": f"Rock {i:02d}", "mbid": f"m{i}", "score": 1.0}
                   for i in range(1, 6)]
    records = {
        "linkin park": _record(similar=overlapping),
        "korn": _record(similar=overlapping),
        "slipknot": _record(similar=overlapping),
        "don omar": _record(similar=[
            {"name": "Reggaeton Uno", "mbid": "r1", "score": 1.0}]),
    }
    weights = {key: 1.0 for key in library}
    out = candidates(library, records, weights, dismissed=set())
    names = [item["name"] for item in out]
    # Sin diversidad, los cinco "Rock NN" (3.0) tapaban al seed distinto (1.0).
    assert names.index("Reggaeton Uno") < 4
    # El score que se devuelve es el normalizado ORIGINAL, sin la penalizacion.
    assert out[0]["score"] == pytest.approx(1.0)
    assert out[1]["score"] == pytest.approx(1.0)
    assert out[3]["score"] == pytest.approx(1 / 3)
    assert all("_seed" not in item for item in out)
