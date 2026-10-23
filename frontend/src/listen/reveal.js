/* ---------------------------------------------------------------------------
   PETICION DE "IR A..." EN ESCUCHAR

   El mini-reproductor (ir a una cancion) y el riel (abrir una lista) viven
   fuera de Escuchar y la pantalla puede no estar montada ni a la vista cuando
   se pide. En vez de acoplarlos con callbacks, la peticion queda aqui hasta que
   ListenView este activo y la recoja: sin React, para que App y ListenView
   compartan el mismo modulo sin pasarse props.
   ------------------------------------------------------------------------- */

let pending = null;
let pendingList = null;
const listeners = new Set();

export function requestReveal(key) {
  pending = key;
  listeners.forEach((fn) => fn());
}

/* Devuelve la clave pendiente y la olvida: una peticion se atiende una vez. */
export function takeReveal() {
  const key = pending;
  pending = null;
  return key;
}

export function requestPlaylist(id) {
  pendingList = id;
  listeners.forEach((fn) => fn());
}

export function takePlaylist() {
  const id = pendingList;
  pendingList = null;
  return id;
}

export function subscribeReveal(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
