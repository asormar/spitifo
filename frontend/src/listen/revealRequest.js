/* "Ver en tu biblioteca": quien lo pide (Ahora suena) deja aqui la clave de la
   cancion y abre Tu biblioteca; la lista la centra cuando esta a la vista. Tu
   biblioteca puede no haberse montado todavia, asi que el pedido vive a nivel
   de modulo (como searchRequest.js) y se consume una sola vez. */

let pending = null;
const listeners = new Set();

export function requestReveal(key) {
  pending = key ?? null;
  listeners.forEach((fn) => fn());
}

export function takeReveal() {
  const key = pending;
  pending = null;
  return key;
}

export function subscribeReveal(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
