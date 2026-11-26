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

const artistCache = new Map();

/* El detalle de un artista se pide una sola vez por sesion y se guarda en
   memoria, igual que loadAlbumTracklist con el album: volver a abrir la misma
   ficha no repite el pedido. Se guarda la promesa, no el resultado, asi dos
   aperturas a la vez comparten el mismo pedido; por eso no lleva signal de
   quien lo pidio (abortarlo dejaria sin ficha a la otra). Un fallo borra la
   entrada para poder reintentar en otra visita. */

/* GET /api/artist/{id} -> { id, name, genre, artwork_url, albums, live,
   compilations, singles }. 404 si no existe, 502 si falla iTunes. */
export function fetchArtist(id) {
  if (artistCache.has(id)) return artistCache.get(id);
  const pending = fetch(`${API}/artist/${encodeURIComponent(id)}`)
    .then(async (r) => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(errMsg(d, "no se pudo abrir el artista"));
      return d;
    })
    .catch((e) => {
      artistCache.delete(id);
      throw e;
    });
  artistCache.set(id, pending);
  return pending;
}
