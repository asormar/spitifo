import { useSyncExternalStore } from "react";
import { API } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   CANCIONES GUARDADAS

   Un almacen externo como playlists.js o history.js: una foto inmutable con el
   registro por id, que se reemplaza entera y avisa a los suscriptores. `load`
   trae GET /api/saved una vez al arrancar. Al anadir una cancion a una lista
   desde "Ahora suena" se guarda primero con `save` y la foto se actualiza al
   instante (optimista), para que la fila aparezca sin esperar al servidor.
   Modulo sin window/document: se importa en Node para los tests.
   ------------------------------------------------------------------------- */

const JSON_HEADERS = { "Content-Type": "application/json" };
const EMPTY = { ready: false, error: false, byId: new Map() };

export function createSaved({ fetchFn = (...a) => fetch(...a) } = {}) {
  let state = EMPTY;
  const listeners = new Set();
  let loading = null;

  const emit = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  const load = (force = false) => {
    if (loading) return loading;
    if (state.ready && !force) return Promise.resolve();
    loading = fetchFn(`${API}/saved`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error("http");
        const byId = new Map();
        (Array.isArray(d.songs) ? d.songs : []).forEach((s) => {
          if (s && s.id) byId.set(s.id, s);
        });
        emit({ ready: true, error: false, byId });
      })
      .catch(() => emit({ ready: false, error: true }))
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  const upsert = (song) => {
    if (!song?.id) return;
    const byId = new Map(state.byId);
    byId.set(song.id, song);
    emit({ byId });
  };

  /* Guarda en el servidor y deja la foto definitiva que devuelve, o vuelve a
     la anterior si falla: lo que se ve y lo guardado no se separan. */
  const save = async (record) => {
    if (!record?.id) return false;
    const before = state.byId;
    upsert(record);
    try {
      const r = await fetchFn(`${API}/saved`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ songs: [record] }),
      });
      if (!r.ok) throw new Error("http");
      const d = await r.json().catch(() => ({}));
      if (Array.isArray(d.songs)) {
        const byId = new Map(state.byId);
        d.songs.forEach((s) => {
          if (s && s.id) byId.set(s.id, s);
        });
        emit({ byId });
      }
      return true;
    } catch {
      emit({ byId: before });
      return false;
    }
  };

  return { subscribe, getState: () => state, load, upsert, save };
}

export const saved = createSaved();

export function useSaved(selector = (s) => s) {
  return useSyncExternalStore(saved.subscribe, () => selector(saved.getState()));
}
