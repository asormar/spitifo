/* ---------------------------------------------------------------------------
   TEXTO DE LOS ALBUMES

   Las frases de la ficha y de la cola, sin React ni DOM, para probarlas en Node.
   ------------------------------------------------------------------------- */

/* El boton principal de la ficha. `done` cuenta solo las pistas completas ya
   bajadas; `running` vale mientras queda algo en cola o descargandose. */
export function albumButton({ matching, full, done = 0, running = false, owned = 0 }) {
  if (matching) return { text: "Buscando versiones…", disabled: true };
  if (full === 0) {
    return { text: owned > 0 ? "Ya está en tu biblioteca" : "Sin versiones completas", disabled: true };
  }
  if (done >= full) return { text: "Álbum descargado", disabled: true };
  if (running) return { text: `Descargando · ${done} de ${full}`, disabled: true };
  /* Con parte del album ya en la biblioteca o ya bajada, el boton habla de lo
     que falta, no del album entero. */
  if (done > 0 || owned > 0) {
    const left = full - done;
    return { text: left === 1 ? "Descargar la que falta" : `Descargar las ${left} que faltan`, disabled: false };
  }
  return { text: `Descargar álbum · ${full} ${full === 1 ? "canción" : "canciones"}`, disabled: false };
}

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
  else list = `${shown[0]}, ${shown[1]} y ${shown[2]} y ${n - 3} más`;
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

/* El hueco de una pista en su disco: «1-9». Una pista de iTunes trae
   disc_number/track_number en `extra`; una entrada de la biblioteca, disc_no y
   track_no. Sin numero de pista no hay hueco. */
export const trackSlot = (disc, track) => (track == null ? null : `${disc ?? 1}-${track}`);

/* Los huecos de un album que ya estan en la biblioteca, por su id de iTunes.
   Con ellos la ficha no vuelve a bajar lo que ya tienes. */
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
