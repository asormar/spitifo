import { useSyncExternalStore } from "react";

/* ---------------------------------------------------------------------------
   SELECCION MULTIPLE DEL ESCRITORIO

   Ctrl/Cmd+clic alterna una fila; Shift+clic toma el rango entre la ultima y la
   actual. El almacen guarda las entradas completas (no solo claves) para que la
   barra de acciones pueda encolarlas sin volver a buscarlas. El calculo del
   rango es puro y se prueba en Node.
   ------------------------------------------------------------------------- */

/* Rango inclusivo de claves entre dos posiciones de la misma lista. */
export const rangeKeys = (keys, from, to) => {
  const a = keys.indexOf(from);
  const b = keys.indexOf(to);
  if (a < 0 || b < 0) return [];
  return keys.slice(Math.min(a, b), Math.max(a, b) + 1);
};

let entries = new Map();
let anchor = null;
let snapshot = [];
const known = new Map();
const watchers = new Set();

const emit = () => {
  snapshot = [...entries.values()];
  watchers.forEach((w) => w());
};

export const selection = {
  subscribe(fn) {
    watchers.add(fn);
    return () => watchers.delete(fn);
  },
  get: () => snapshot,
  has: (key) => entries.has(key),
  /* Las filas se recuerdan al pintarse para que Shift+clic pueda reconstruir
     las entradas del rango solo con las claves que hay en el DOM. */
  remember: (entry) => known.set(entry.key, entry),
  rangeFromKeys(keys, key) {
    this.range(keys.map((k) => known.get(k)).filter(Boolean), key);
  },
  clear() {
    if (!entries.size) return;
    entries = new Map();
    anchor = null;
    emit();
  },
  toggle(entry) {
    if (entries.has(entry.key)) entries.delete(entry.key);
    else entries.set(entry.key, entry);
    anchor = entry.key;
    emit();
  },
  /* `list` son las entradas de la lista visible, en orden de pantalla; `key`
     es la fila que se acaba de pulsar. */
  range(list, key) {
    const keys = list.map((e) => e.key);
    const from = anchor && keys.includes(anchor) ? anchor : key;
    const picked = rangeKeys(keys, from, key);
    entries = new Map(picked.map((k) => [k, list.find((e) => e.key === k)]).filter(([, e]) => e));
    emit();
  },
};

export const useSelection = () => useSyncExternalStore(selection.subscribe, selection.get);
