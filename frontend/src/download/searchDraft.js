import { useSyncExternalStore } from "react";

/* ---------------------------------------------------------------------------
   TEXTO DE LA BUSQUEDA

   Lo que el usuario escribe en el buscador. Vive aqui y no en un useState de
   Buscar para que mas de un campo lo lean y lo escriban (el de la pantalla y
   el de la barra superior en PC) y el texto sobreviva al cambiar de pestana.

   No toca window ni document: se importa en Node para los tests.
   ------------------------------------------------------------------------- */

export function createSearchDraft() {
  let q = "";
  const listeners = new Set();

  const set = (value) => {
    const next = typeof value === "function" ? value(q) : String(value ?? "");
    if (next === q) return;
    q = next;
    listeners.forEach((fn) => fn());
  };

  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  return { subscribe, get: () => q, set };
}

export const searchDraft = createSearchDraft();

/* [texto, escribir]: la misma forma que un useState. */
export function useSearchDraft() {
  const q = useSyncExternalStore(searchDraft.subscribe, searchDraft.get);
  return [q, searchDraft.set];
}
