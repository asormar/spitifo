import { useSyncExternalStore } from "react";

/* ---------------------------------------------------------------------------
   ALMACENES PEQUENOS DE LA BUSQUEDA

   `searchDraft` es lo que el usuario escribe en el buscador. Vive aqui y no en
   un useState de Buscar para que mas de un campo lo lean y lo escriban (el de
   la pantalla y el de la barra superior en PC) y el texto sobreviva al cambiar
   de pestana. `searchBusy` dice si hay una busqueda en vuelo: la barra de
   arriba lo lee para el "Buscando" y la orbita de la lupa.

   No toca window ni document: se importa en Node para los tests.
   ------------------------------------------------------------------------- */

export function createStore(initial, coerce = (v) => v) {
  let value = coerce(initial);
  const listeners = new Set();

  const set = (next) => {
    const v = coerce(typeof next === "function" ? next(value) : next);
    if (Object.is(v, value)) return;
    value = v;
    listeners.forEach((fn) => fn());
  };

  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  return { subscribe, get: () => value, set };
}

/* Siempre un texto: null y undefined dejan el campo vacio. */
export const createSearchDraft = () => createStore("", (v) => String(v ?? ""));

export const searchDraft = createSearchDraft();
export const searchBusy = createStore(false, Boolean);

/* [valor, escribir]: la misma forma que un useState. */
export function useStore(store) {
  const value = useSyncExternalStore(store.subscribe, store.get);
  return [value, store.set];
}

export const useSearchDraft = () => useStore(searchDraft);
export const useSearchBusy = () => useSyncExternalStore(searchBusy.subscribe, searchBusy.get);
