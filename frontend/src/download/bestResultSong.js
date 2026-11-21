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
