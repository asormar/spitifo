/* ---------------------------------------------------------------------------
   TEXTO DE LOS ALBUMES

   Las frases de la ficha y de la cola, sin React ni DOM, para probarlas en Node.
   ------------------------------------------------------------------------- */

/* El boton principal de la ficha. `done` cuenta solo las pistas completas ya
   bajadas; `running` vale mientras queda algo en cola o descargandose. */
export function albumButton({ matching, full, done = 0, running = false }) {
  if (matching) return { text: "Buscando versiones…", disabled: true };
  if (full === 0) return { text: "Sin versiones completas", disabled: true };
  if (done >= full) return { text: "Álbum descargado", disabled: true };
  if (running) return { text: `Descargando · ${done} de ${full}`, disabled: true };
  if (done > 0) return { text: `Descargar las ${full - done} que faltan`, disabled: false };
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
