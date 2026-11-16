/* ---------------------------------------------------------------------------
   BUSCAR PORTADAS: estado de la cola (puro, sin React ni red)

   La cola son los temas de audio sin portada que devuelve el backend. Se
   avanza de a uno: "saved" (se guardo la elegida), "skip" (el usuario salto) o
   "taken" (el backend dijo 409: ya tenia portada, por ejemplo de otro
   dispositivo). Nada aca elige una portada: eso lo hace solo el usuario.
   ------------------------------------------------------------------------- */

export const initialFinder = {
  status: "loading",
  items: [],
  idx: 0,
  saved: 0,
  skipped: 0,
  taken: 0,
  error: null,
};

export function finderReducer(state, action) {
  switch (action.type) {
    case "loaded": {
      const items = Array.isArray(action.items) ? action.items : [];
      return {
        ...initialFinder,
        status: items.length ? "ready" : "empty",
        items,
      };
    }
    case "failed":
      return { ...state, status: "error", error: action.error };
    case "saved":
    case "skip":
    case "taken": {
      if (state.status !== "ready") return state;
      const field = action.type === "skip" ? "skipped" : action.type;
      const idx = state.idx + 1;
      return {
        ...state,
        [field]: state[field] + 1,
        idx,
        status: idx >= state.items.length ? "done" : "ready",
      };
    }
    case "finish":
      return state.status === "ready" ? { ...state, status: "done" } : state;
    default:
      return state;
  }
}

/* La portada candidata se muestra a 200 px (la de 300 se pide para guardar). */
export function previewUrl(url) {
  return typeof url === "string" ? url.replace("/300x300bb.", "/200x200bb.") : null;
}

/* "Artista · Album · 2004" sin los huecos de lo que falta. */
export function candidateMeta(c) {
  return [c?.artist, c?.album, c?.year].filter(Boolean).join(" · ");
}
