import { API, errMsg } from "../shared/api.js";
import { popularSongs } from "./bestResultSong.js";

/* ---------------------------------------------------------------------------
   POPULARES DE TODAS LAS PAGINAS DE ARTISTA

   El top llega de /api/artist/{id}/top, que se pide aparte de la discografia
   para que la pagina pinte sin esperar a YouTube. Con iTunes caido o sin
   canciones se cae a los resultados de la Buscar que abrieron la pagina.
   Modulo del chunk del artista: el arranque no paga ni un byte.
   ------------------------------------------------------------------------- */

/* GET /api/artist/{id}/top -> { id, name, songs: [Track, ...] }.
   El backend responde 200 con songs: [] ante cualquier error, asi que esto
   solo falla de verdad si la propia API no esta. */
export async function fetchArtistTop(id, signal) {
  const r = await fetch(`${API}/artist/${encodeURIComponent(id)}/top`, { signal });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errMsg(d, "no se pudieron cargar las canciones"));
  return Array.isArray(d.songs) ? d.songs : [];
}

/* Puro: elige la fuente de Populares. Gana la del backend; si no trae nada,
   se usan los resultados de la Buscar (que ya filtra por artista y reproduce).
   Los dos caminos respetan el tope de cinco y el plan de reproduccion. */
export function artistPopulares(backend = [], data = null, results = [],
                                name = null, plan, limit = 5) {
  const delBackend = Array.isArray(backend) ? backend : [];
  if (delBackend.length) {
    return delBackend
      .filter((t) => t && (!plan || plan(t)))
      .slice(0, limit);
  }
  return popularSongs(data, results, name, plan, limit);
}
