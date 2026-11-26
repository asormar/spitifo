/* ---------------------------------------------------------------------------
   GENEROS SEMILLA

   Mientras no hay historial, Descubrir y el primer paso de Inicio ofrecen los
   mismos generos conocidos. Puro, sin React ni DOM: se prueba en Node.
   ------------------------------------------------------------------------- */

export const STARTER_GENRE = "Rock";
export const STARTER_GENRES = [STARTER_GENRE, "Jazz", "Pop"];

/* El primero que ya conozca el mapa, o la semilla fija si la recomendacion
   todavia no llego. */
export function starterGenre(names) {
  const first = Array.isArray(names) ? names.find((name) => typeof name === "string" && name.trim()) : null;
  return first ? first.trim() : STARTER_GENRE;
}
