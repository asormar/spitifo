/* ---------------------------------------------------------------------------
   PETICION DE "IR A LA CANCION"

   El mini-reproductor vive fuera de Escuchar y la lista puede no estar montada
   ni a la vista cuando se pide. En vez de acoplar los dos con callbacks, la
   peticion queda aqui hasta que ListenView este activo y la recoja: sin React,
   para que App y ListenView compartan el mismo modulo sin pasarse props.
   ------------------------------------------------------------------------- */

let pending = null;
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

export function subscribeReveal(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
