import { plural, recentEntries, topItems } from "./home.js";

/* ---------------------------------------------------------------------------
   MEZCLA DEL INICIO

   Las cuatro mezclas del disco de Inicio y que canciones entra en cada una.
   Todas dejan fuera los videos (no suenan en la cola). Solo se calcula la
   mezcla elegida, no las cuatro. Las cifras son constantes para poder
   cambiarlas en un sitio.
   ------------------------------------------------------------------------- */

export const MIXES = [
  ["all", "Toda tu biblioteca"],
  ["top", "Lo que más escuchas"],
  ["recent", "Añadido hace poco"],
  ["new", "Sin escuchar todavía"],
];

const RECENT_MIX = 30;
const TOP_MIX = 100;

export const mixName = (key) => (MIXES.find((m) => m[0] === key) || MIXES[0])[1];

/* Una cancion con algun reproducir u omitir ya se ha oido: omitir cuenta. */
const heard = (t) => Boolean(t) && ((Number(t.plays) || 0) > 0 || (Number(t.skips) || 0) > 0);

/* `hist` es la foto del historial ({ tracks }) y `byKey` el mapa clave -> entrada
   de la biblioteca. Sin historial, "nuevas" es todo y "mas escuchadas" no tiene
   nada. Una clave desconocida cae en "all". */
export function mixEntries(key, entries, hist, byKey) {
  if (key === "recent") return recentEntries(entries, RECENT_MIX);
  if (key === "top") return topItems(hist, byKey, TOP_MIX).map((t) => t.entry);
  const songs = entries.filter((e) => e.kind !== "video");
  return key === "new" ? songs.filter((e) => !heard(hist?.tracks?.[e.key])) : songs;
}

/* La linea bajo el titulo del disco. Una mezcla vacia dice por que. */
export function mixSub(key, n) {
  if (n > 0) return `${plural(n, "canción", "canciones")} en orden aleatorio, sin fin`;
  if (key === "top") return "Aún no hay canciones escuchadas.";
  if (key === "new") return "Ya has escuchado toda tu biblioteca.";
  return "Todavía no hay canciones.";
}
