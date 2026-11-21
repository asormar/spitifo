import { canStream } from "./streamTrack.js";

/* ---------------------------------------------------------------------------
   QUE SUENA DE UN ALBUM QUE VIENE DE BUSCAR

   El emparejamiento llega por lotes (5-15 s). Una pista ya es reproducible en
   cuanto tiene video; la que solo tiene avance suena 30 s; la que todavia se
   esta buscando no se toca. Modulo puro, sin React ni DOM: se prueba en Node.
   ------------------------------------------------------------------------- */

export function albumPlayable(t) {
  if (!t) return false;
  if (canStream(t)) return true;
  /* Un preview de iTunes solo vale cuando el match ya dijo que no hay version
     completa. Mientras `has_full` es null, la pista sigue «buscando…». */
  return t?.extra?.has_full === false && Boolean(t?.preview_url);
}

/* Las que pueden sonar, en orden del disco (no se ordenan de nuevo). */
export function albumQueue(tracks = []) {
  return (Array.isArray(tracks) ? tracks : []).filter(albumPlayable);
}

/* La linea discreta bajo la cabecera: «7 de 12 listas». */
export function matchProgress(tracks = [], ready = albumQueue(tracks).length) {
  return `${ready} de ${tracks.length} listas`;
}
