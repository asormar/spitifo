import { useSyncExternalStore } from "react";

/* ---------------------------------------------------------------------------
   PANEL DE "AHORA SUENA"

   El estado del panel vive en un almacen de modulo, como el del motor y el del
   video: abrirlo, cambiar de pestana o ampliarlo no pasa por el estado de App.
     open   abierto o cerrado
     tab    0 Ahora suena, 1 Cola, 2 Ficha
     wide   ampliado (escritorio: la pestana 0 ocupa el sitio de las paginas)
     at     viewKey de la vista en que se abrio o se amplio: la ampliacion se
            suelta al navegar, y en Descubrir solo flota donde se abrio

   `panelMode` decide como se pinta ese estado; es pura y se prueba en Node.
   ------------------------------------------------------------------------- */

let state = { open: false, tab: 0, wide: false, at: "" };
const watchers = new Set();

const same = (a, b) => a.open === b.open && a.tab === b.tab && a.wide === b.wide && a.at === b.at;

function set(next) {
  if (same(state, next)) return;
  state = next;
  watchers.forEach((w) => w());
}

export const panel = {
  get: () => state,
  subscribe(cb) {
    watchers.add(cb);
    return () => watchers.delete(cb);
  },
  /* Abre (o cambia de pestana). Fuera de la pestana 0 no hay ampliado. */
  show(tab = 0, at = state.at) {
    set({ open: true, tab, wide: state.open && state.wide && tab === 0, at });
  },
  /* Amplia: siempre en la pestana Ahora suena. */
  expand(at = state.at) {
    set({ open: true, tab: 0, wide: true, at });
  },
  collapse() {
    set({ ...state, wide: false });
  },
  close() {
    set({ ...state, open: false, wide: false });
  },
};

export function usePanel(select = (s) => s) {
  return useSyncExternalStore(panel.subscribe, () => select(state));
}

/* off     cerrado o sin pista
   full    pantalla completa (por debajo de 960 px, sea cual sea el estado)
   docked  columna al lado de las paginas
   wide    ampliado sobre las paginas (solo si sigue en la vista que lo amplio)
   over    en Descubrir flota encima, solo si se abrio alli: ahi no hay sitio
           para la columna */
export function panelMode(s, { key, discover, pc, track }) {
  if (!track || !s.open) return "off";
  if (!pc) return "full";
  if (discover) return s.at === key ? "over" : "off";
  return s.wide && s.tab === 0 && s.at === key ? "wide" : "docked";
}
