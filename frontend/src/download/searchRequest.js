/* Pedido de busqueda desde otra pantalla (el mapa de generos de Descubrir).
   Descargar vive montado aunque no se vea, o todavia no se montó: un valor a
   nivel de modulo sobrevive a las dos situaciones. Quien pide lo deja aca y
   DownloadView lo consume al montarse o en cuanto se avisa. */

let pending = null;
const listeners = new Set();

export function requestSearch(text) {
  const t = String(text ?? "").trim();
  if (!t) return;
  pending = t;
  listeners.forEach((fn) => fn());
}

/* Devuelve el texto pendiente una sola vez. */
export function takeSearch() {
  const t = pending;
  pending = null;
  return t;
}

export function subscribeSearch(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
