from backend.app.suggest import suggestions_from_raw


def raw(track, artist, track_id, artist_id, collection=None, collection_id=None):
    return {
        "trackName": track,
        "artistName": artist,
        "trackId": track_id,
        "artistId": artist_id,
        "collectionName": collection or track,
        "collectionId": collection_id if collection_id is not None else track_id,
        "kind": "song",
    }


def test_sugerencias_salen_de_una_pagina_y_se_intercalan():
    filas = [
        raw("Mesmerizer", "Satsuki", 1, 11, "Album 1", 101),
        raw("Otra", "Satsuki", 2, 11, "Album 1", 101),
        raw("Tercera", "Otro", 3, 12, "Album 2", 102),
    ]
    out = suggestions_from_raw(filas, limit=9)
    assert [s["kind"] for s in out[:3]] == ["song", "artist", "album"]
    assert [s["title"] for s in out if s["kind"] == "song"] == ["Mesmerizer", "Otra", "Tercera"]
    assert [s["title"] for s in out if s["kind"] == "artist"] == ["Satsuki", "Otro"]
    assert [s["title"] for s in out if s["kind"] == "album"] == ["Album 1", "Album 2"]


def test_limita_el_tamano_y_ignora_entradas_inutiles():
    filas = [raw(f"Cancion {i}", "Artista", i, 99) for i in range(10)] + [None, {}, {"trackName": ""}]
    out = suggestions_from_raw(filas, limit=6)
    assert len(out) == 6
    assert all(s["source"] == "itunes" for s in out)


def test_sin_datos_no_hace_nada():
    assert suggestions_from_raw([]) == []
    assert suggestions_from_raw(None) == []
