/* ---------------------------------------------------------------------------
   TEXTO DE LOS ALBUMES

   Las frases de la ficha y de la cola, sin React ni DOM, para probarlas en Node.
   ------------------------------------------------------------------------- */

/* ««Hombre al agua» no tiene versión completa: solo se puede escuchar 30 s.»
   Hasta tres titulos y, si hay mas, «y N más». */
export function missingSentence(titles = []) {
  const n = titles.length;
  if (!n) return "";
  const shown = titles.slice(0, 3).map((t) => `«${t}»`);
  let list;
  if (n === 1) list = shown[0];
  else if (n === 2) list = `${shown[0]} y ${shown[1]}`;
  else if (n === 3) list = `${shown[0]}, ${shown[1]} y ${shown[2]}`;
  else list = `${shown[0]}, ${shown[1]}, ${shown[2]} y ${n - 3} más`;
  return `${list} ${n === 1 ? "no tiene" : "no tienen"} versión completa: solo se pued${
    n === 1 ? "e" : "en"
  } escuchar 30 s.`;
}

/* El resumen de un grupo terminado, para el toast. */
export function groupToast(title, { done, total, failed }) {
  if (failed > 0) {
    return `${title}: ${done} de ${total}, ${failed} ${failed === 1 ? "falló" : "fallaron"}`;
  }
  return `${title}: ${done} ${done === 1 ? "descargada" : "descargadas"}`;
}

/* --- Descargas que no se pierden -------------------------------------------- */

/* Al reenganchar tras recargar: una sola frase para toda la cola que venia
   andando. */
export function reattachText(n) {
  return n === 1
    ? "Seguimos con la descarga que dejaste en marcha."
    : `Seguimos con ${n} descargas que dejaste en marcha.`;
}

export const OFFLINE_BANNER = "Sin conexión. Las descargas siguen solas en cuanto vuelva la red.";
export const OFFLINE_PILL = "Sin conexión · en pausa";
export const pausedText = (pct) => `En pausa · sin red · ${Math.round(pct)} %`;
export const resumingText = (pct) => `Retomando desde ${Math.round(pct)} %`;

/* La forma de item que espera POST /api/downloads. La usan la ficha del album
   y la lista de discografia: una sola definicion, sin copias. `downloadable`
   lo decide el servidor, asi que no se envia. */
export function trackSpec(track, query, fmt = "original") {
  const copy = { ...track };
  delete copy.downloadable;
  /* "original" por defecto: conserva el contenedor de la fuente y NO paga una
     recodificacion. mp3 solo se envia cuando el usuario lo eligio. */
  return { source: copy.source, track: copy, fmt, media: "audio", query };
}

/* El hueco de una pista en su disco: «1-9». Una pista de iTunes trae
   disc_number/track_number en `extra`; una entrada de la biblioteca, disc_no y
   track_no. Sin numero de pista no hay hueco. */
export const trackSlot = (disc, track) => (track == null ? null : `${disc ?? 1}-${track}`);

/* Los huecos de un album que ya estan en la biblioteca, por su id de iTunes.
   Con ellos la ficha no vuelve a bajar lo que ya tienes. */
/* Lo mismo, pero con la entrada de la biblioteca de cada hueco: «Escuchar»
   toca esas desde el archivo propio (al instante, sin datos) y el resto en
   streaming. */
export function ownedEntries(entries, albumId) {
  const id = albumId == null ? "" : String(albumId);
  const out = new Map();
  if (!id) return out;
  for (const e of entries || []) {
    if (e?.album_id == null || String(e.album_id) !== id) continue;
    const slot = trackSlot(e.disc_no, e.track_no);
    if (slot && !out.has(slot)) out.set(slot, e);
  }
  return out;
}

export function ownedSlots(entries, albumId) {
  const id = albumId == null ? "" : String(albumId);
  const out = new Set();
  if (!id) return out;
  for (const e of entries || []) {
    if (e?.album_id == null || String(e.album_id) !== id) continue;
    const slot = trackSlot(e.disc_no, e.track_no);
    if (slot) out.add(slot);
  }
  return out;
}
