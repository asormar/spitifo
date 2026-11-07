/* ---------------------------------------------------------------------------
   PEDIDO ENTRE PANTALLAS

   Una pantalla le pide algo a otra que vive montada (aunque no se vea) o que
   todavia no se monto: un valor a nivel de modulo sobrevive a las dos
   situaciones. Quien pide lo deja aca y la otra lo consume al montarse o en
   cuanto se avisa. Solo se guarda el ultimo pedido y se entrega una vez.

   No toca window ni document: se importa en Node para los tests.
   ------------------------------------------------------------------------- */

export function createRequestSlot() {
  let pending = null;
  const listeners = new Set();

  const request = (text) => {
    const t = String(text ?? "").trim();
    if (!t) return;
    pending = t;
    listeners.forEach((fn) => fn());
  };

  /* Devuelve el texto pendiente una sola vez. */
  const take = () => {
    const t = pending;
    pending = null;
    return t;
  };

  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  return { request, take, subscribe };
}
