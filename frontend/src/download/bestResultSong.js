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

   Hoy /api/artist/{id} no trae canciones destacadas, asi que la fuente son los
   resultados de la Buscar que abrio la pagina (el id, el nombre y los resultados
   viajan en la entrada de navegacion; ningun estado global nuevo). Si un dia el
   payload trae `top_songs`, esos tienen prioridad. Solo se toman los que suenan.
   ------------------------------------------------------------------------- */

export function popularSongs(data = null, results = [], name = null, plan = rowPlayPlan, limit = 5) {
  if (!name) return [];
  const top = Array.isArray(data?.top_songs) ? data.top_songs : [];
  const source = top.length ? top : Array.isArray(results) ? results : [];
  return source
    .filter((t) => t && plan(t) && (top.length || isArtistNameMatch(name, t.artist)))
    .slice(0, limit);
}
