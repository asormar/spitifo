import { API, errMsg } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   LOS DOS PEDIDOS DE LOS ARTISTAS

   La busqueda va en paralelo con las canciones y no las espera: si iTunes
   falla, devuelve una lista vacia y Buscar sigue igual. El detalle lo pide la
   pagina del artista, que vive en su propio chunk.
   ------------------------------------------------------------------------- */

/* GET /api/artists/search -> { query, results: [{ id, name, genre }] }. */
export async function searchArtists(q, limit = 3, signal) {
  const r = await fetch(`${API}/artists/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errMsg(d, "no se pudieron buscar los artistas"));
  return Array.isArray(d.results) ? d.results : [];
}

/* GET /api/artist/{id} -> { id, name, genre, artwork_url, albums, live,
   compilations, singles }. 404 si no existe, 502 si falla iTunes. */
export async function fetchArtist(id, signal) {
  const r = await fetch(`${API}/artist/${encodeURIComponent(id)}`, { signal });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errMsg(d, "no se pudo abrir el artista"));
  return d;
}
