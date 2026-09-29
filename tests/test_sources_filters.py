"""Filtros anti-basura de `sources.py`: `looks_like_music` y `relevance`.

Internet Archive guarda audio en general, no musica: con la consulta relajada,
buscar "Numb Linkin Park" devolvia "HUBS report" y "Chaos in Portland". Estos
dos filtros son los que limpian esa basura, asi que van tabulados con los
valores reales que se midieron.

Offline puro: no tocan la red.
"""
from __future__ import annotations

import pytest

from backend.app.sources import (
    NOT_MUSIC,
    InternetArchiveSource,
    _distinctive,
    _loose,
    _words,
    looks_like_music,
    relevance,
)
from backend.app.models import Track


@pytest.mark.parametrize("titulo,artista,esperado", [
    # musica de verdad: pasa
    ("Numb", "Linkin Park", True),
    ("Bohemian Rhapsody", "Queen", True),
    ("Kind of Blue", "Miles Davis", True),
    # audio que NO es musica: se descarta
    ("HUBS report", "Vanguard", False),
    ("Numb", "The HUBS Podcast", False),
    ("Numb", "Piano lesson", False),
    ("Numb", "Some Meeting Minutes", False),
    ("Numb", "Daily briefing", False),
])
def test_looks_like_music_tabla(titulo, artista, esperado):
    assert looks_like_music(titulo, artista) is esperado


def test_looks_like_music_mira_titulo_y_artista():
    """La palabra pode estar en cualquiera de los dos campos."""
    assert looks_like_music("Numb", "Podcast X") is False
    assert looks_like_music("Sermon del viernes", "Nadie") is False


@pytest.mark.xfail(
    strict=True,
    reason="DEUDA CONOCIDA: NOT_MUSIC esta en ingles ('course') y no tiene "
           "'curso' en español, asi que 'Curso de Python' pasa el filtro. "
           "strict=True para que el día que se arregle sources.py este test "
           "FALLE y obligue a sacar el marcador (xfail no puede pasar inadvertido).")
def test_looks_like_music_deberia_filtrar_un_curso():
    """Un curso de Python no es musica: deberia quedar afuera."""
    assert looks_like_music("Curso de Python desde cero", "didacticopanda") is False


def test_not_music_tiene_palabras_que_atreven():
    """Guarda contra que alguien vacie la lista de palabras anti-basura."""
    assert {"podcast", "report", "sermon", "lecture", "audiobook"} <= NOT_MUSIC


# ------------------------------------------------------------------ relevance
@pytest.mark.parametrize("query,titulo,artista,esperado", [
    # el caso que motivo el filtro: matchea UNA palabra y nada mas
    ("Numb Linkin Park", "Park Rascals", "Park Rascals", 0.13),
    ("Numb Linkin Park", "Numb", "Linkin Park", 1.0),
    ("Numb Linkin Park", "HUBS report", "Vanguard", 0.0),
    ("Bohemian Rhapsody", "Bohemian Rhapsody", "Queen", 1.0),
    # "jazz" es un genero, no aparece en el titulo: no matchea nada
    ("jazz", "Kind of Blue", "Miles Davis", 0.0),
    # query de una sola palabra distintiva: cobertura normal, sin penalizacion
    ("Numb", "Numb", "Linkin Park", 1.0),
])
def test_relevance_tabla(query, titulo, artista, esperado):
    assert relevance(query, titulo, artista) == pytest.approx(esperado, abs=0.005)


def test_relevance_casting_parte_medio_mal():
    """Un item que solo matchea la mitad de las palabras se penaliza.

    Es lo que hace que "Park Rascals" no llegue arriba de "Numb" en la lista
    aunque tenga una palabra de la consulta.
    """
    # 1 de 3 palabras distintivas = 0.33 de cobertura -> 0.33 * 0.4
    assert relevance("Numb Linkin Park", "Park Rascals", "Park Rascals") < 0.2


def test_relevance_ordena_el_item_correcto_arriba():
    """El resultado que hay que mostrar tiene mas relevancia que el ruido."""
    assert (relevance("Numb Linkin Park", "Numb", "Linkin Park")
            > relevance("Numb Linkin Park", "Park Rascals", "Park Rascals"))


@pytest.mark.parametrize("query,esperado", [
    ("Numb Linkin Park", '("Linkin" OR "Numb" OR "Park") AND mediatype:(audio)'),
    ("Bohemian Rhapsody", '("Bohemian" OR "Rhapsody") AND mediatype:(audio)'),
    # solo palabras vacias -> no hay query de respaldo
    ("  ", None),
    ("a", None),
    ("de la", None),
])
def test_loose_arma_el_or_de_respaldo(query, esperado):
    """Archive exige AND entre palabras; el OR es el plan B."""
    assert _loose(query) == esperado


def test_words_y_distinctive():
    assert _words("Numb (Live) [Official]") == ["numb", "live", "official"]
    # 'live' es FILLER: no sirve para discriminar
    assert _distinctive("Numb Linkin Park") == {"numb", "linkin", "park"}


# ------------------------------------------------------------------ _rank
def _track(titulo, artista, source_id="x") -> Track:
    return Track(source="archive", source_id=source_id, title=titulo, artist=artista)


def test_rank_descarta_audio_no_musical():
    """`_rank` es lo que corre antes de mostrar cualquier resultado de archive."""
    src = InternetArchiveSource()
    tracks = [
        _track("HUBS report", "Vanguard", "ruido1"),
        _track("Numb", "Linkin Park", "bien"),
    ]
    out = src._rank("Numb Linkin Park", tracks)
    assert [t.source_id for t in out] == ["bien"]


def test_rank_ordena_por_relevancia_real():
    """El item correcto tiene que subir al primer lugar, no aparecer 3ro."""
    src = InternetArchiveSource()
    tracks = [
        _track("Park Rascals", "Park Rascals", "ruido"),
        _track("Numb", "Linkin Park", "bien"),
    ]
    out = src._rank("Numb Linkin Park", tracks)
    assert out[0].source_id == "bien"
    assert out[0].extra["relevance"] >= out[-1].extra["relevance"]


def test_rank_con_min_relevance_descarta_lo_que_no_matchea_nada():
    """Con el OR relajado aparecen falsos positivos por una palabra comun."""
    src = InternetArchiveSource()
    tracks = [
        _track("In The End", "Linkin Park", "medio"),
        _track("Despertar Temprano", "Varios", "cero"),
    ]
    out = src._rank("Numb Linkin Park", tracks, min_relevance=0.01)
    assert [t.source_id for t in out] == ["medio"]
