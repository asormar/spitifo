import { API, errMsg } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   LOS TRES PEDIDOS DE LOS ALBUMES

   La busqueda la hace Buscar en paralelo con las canciones; el detalle y el
   emparejamiento los hace la ficha (en su chunk). Los tres comparten el mismo
   fetch pelado y el mismo manejo de errores.
   ------------------------------------------------------------------------- */

/* GET /api/albums/search -> { query, albums: [...] }. iTunes caido devuelve
   una lista vacia (no un error), asi que no hay estante en ese caso. */
export async function searchAlbums(q, signal) {
  const r = await fetch(`${API}/albums/search?q=${encodeURIComponent(q)}&limit=8`, { signal });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errMsg(d, "no se pudieron buscar los álbumes"));
  return Array.isArray(d.albums) ? d.albums : [];
}

/* GET /api/album/{id}: la lista real del disco, con has_full todavia null. */
export async function fetchAlbumDetail(id, signal) {
  const r = await fetch(`${API}/album/${encodeURIComponent(id)}`, { signal });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errMsg(d, "no se pudo abrir el álbum"));
  return d;
}

/* GET /api/album/{id}/match: puede tardar 5-15 s (busca video por pista). */
export async function fetchAlbumMatch(id, signal) {
  const r = await fetch(`${API}/album/${encodeURIComponent(id)}/match`, { signal });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errMsg(d, "no se pudieron buscar las versiones completas"));
  return d;
}
