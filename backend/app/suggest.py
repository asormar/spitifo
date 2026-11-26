"""Sugerencias baratas para escribir en Buscar.

Una sola llamada a iTunes (la misma que ya usa el matcher) alimenta la lista de
sugerencias: no se toca YouTube ni el stream NDJSON. Lo que hace falta para
pintar cada fila se saca de los mismos dicts crudos, asi que el endpoint no
agrega circulos de red. Modulo puro: se prueba sin servidor.
"""

from __future__ import annotations


def suggestions_from_raw(raws: list[dict], limit: int = 6) -> list[dict]:
    """Canciones, artistas y albumes de una pagina de iTunes, sin repetir.

    El orden de iTunes es el ranking: se conserva dentro de cada tipo. Los tres
    tipos se intercalan para que la primera fila sea una cancion y no una lista
    de artistas repetidos. `limit` acota el tamano de la respuesta.
    """
    canciones, artistas, albumes = [], [], []
    vistos_a, vistos_c = set(), set()
    for raw in raws or []:
        if not isinstance(raw, dict):
            continue
        artista = str(raw.get("artistName") or "").strip()
        titulo = str(raw.get("trackName") or "").strip()
        track_id = raw.get("trackId")
        if titulo and track_id is not None:
            canciones.append({
                "kind": "song", "id": str(track_id), "title": titulo,
                "sub": artista, "source": "itunes",
            })
        aid = raw.get("artistId")
        if aid is not None and artista and aid not in vistos_a:
            vistos_a.add(aid)
            artistas.append({
                "kind": "artist", "id": str(aid), "title": artista,
                "sub": "Artista", "source": "itunes",
            })
        cid = raw.get("collectionId")
        coleccion = str(raw.get("collectionName") or "").strip()
        if cid is not None and coleccion and cid not in vistos_c:
            vistos_c.add(cid)
            albumes.append({
                "kind": "album", "id": str(cid), "title": coleccion,
                "sub": artista, "source": "itunes",
            })

    out = []
    i = 0
    while len(out) < limit:
        anadido = False
        for pool in (canciones, artistas, albumes):
            if i < len(pool):
                out.append(pool[i])
                anadido = True
                if len(out) >= limit:
                    break
        if not anadido:
            break
        i += 1
    return out
