import { isArtistNameMatch } from "./artistLogic.js";
import { rowPlayPlan } from "./rowPlayPlan.js";

/* ---------------------------------------------------------------------------
   LA CANCION DEL MEJOR RESULTADO

   La tarjeta del artista reproduce su primer resultado que se pueda tocar: el
   primero de la lista cuyo artista coincide (tildes, mayusculas y articulo
   inicial inclusive) y para el que rowPlayPlan tenga un plan. Si la tarjeta no
   es de un artista o no hay coincidencia, no hay boton. Modulo puro, sin React
   ni DOM: se prueba en Node.
   ------------------------------------------------------------------------- */

export function bestResultSong(results = [], artist = null, plan = rowPlayPlan) {
  if (!artist?.name || !Array.isArray(results)) return null;
  return (
    results.find((t) => isArtistNameMatch(artist.name, t?.artist) && plan(t)) || null
  );
}

/* ---------------------------------------------------------------------------
   POPULARES DE UN ARTISTA

   /api/artist/{id} no trae canciones destacadas: la fuente son los resultados
   de la Buscar que abrio la pagina (el nombre y los resultados viajan en la
   entrada de navegacion; ningun estado global nuevo). ResultRow decide como
   suena cada fila, previews de 30 s incluidos, asi que aqui no se filtra plan.
   ------------------------------------------------------------------------- */

export function popularSongs(results = [], name = null, limit = 5) {
  if (!name || !Array.isArray(results)) return [];
  return results
    .filter((t) => t && isArtistNameMatch(name, t.artist))
    .slice(0, limit);
}
