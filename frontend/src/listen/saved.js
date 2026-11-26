import { useSyncExternalStore } from "react";
import { API } from "../shared/api.js";
import { sameMap } from "../shared/mapEq.js";

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

  /* `filter` deja fuera lo que se esta borrando con deshacer pendiente: una
     recarga no puede resucitar la fila que acabamos de ocultar. */
  const load = (force = false, filter = null) => {
    if (loading) return loading;
    if (state.ready && !force) return Promise.resolve();
    loading = fetchFn(`${API}/saved`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error("http");
        const byId = new Map();
        let songs = Array.isArray(d.songs) ? d.songs : [];
        if (filter) songs = filter(songs) || [];
        songs.forEach((s) => {
          if (s && s.id) byId.set(s.id, s);
        });
        /* Una recarga forzada (App.jsx pide /api/saved en CADA refresco de
           biblioteca) casi siempre trae lo mismo: si el contenido no cambio,
           se conserva el Map viejo para que mergeLibrary en ListenProvider no
           vuelva a juntar los 20k archivos por nada (P-large-library-scale-6,
           P-render-main-thread-7). */
        emit({ ready: true, error: false, byId: sameMap(byId, state.byId) ? state.byId : byId });
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

  /* Ocultar/restaurar es la foto local del borrado con deshacer: el tombstone
     definitivo lo escribe `remove` solo si vence la ventana. */
  const hide = (ids) => {
    if (!ids?.length) return;
    const byId = new Map(state.byId);
    ids.forEach((id) => byId.delete(id));
    emit({ byId });
  };

  const restore = (songs) => {
    if (!songs?.length) return;
    const byId = new Map(state.byId);
    songs.forEach((s) => s?.id && byId.set(s.id, s));
    emit({ byId });
  };

  const remove = async (ids) => {
    if (!ids?.length) return true;
    try {
      const r = await fetchFn(`${API}/saved/remove`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ids }),
      });
      if (!r.ok) return false;
      hide(ids);
      return true;
    } catch {
      return false;
    }
  };

  /* Guarda en el servidor y deja la foto definitiva que devuelve, o vuelve a
     la anterior si falla: lo que se ve y lo guardado no se separan. Un solo
     PUT admite varias canciones (el boton "Guardar album"). */
  const saveAll = async (records) => {
    const list = (records || []).filter((s) => s?.id);
    if (!list.length) return false;
    const before = state.byId;
    const byId = new Map(state.byId);
    list.forEach((s) => byId.set(s.id, s));
    emit({ byId });
    try {
      const r = await fetchFn(`${API}/saved`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ songs: list }),
      });
      if (!r.ok) throw new Error("http");
      const d = await r.json().catch(() => ({}));
      if (Array.isArray(d.songs)) {
        const fresh = new Map(state.byId);
        d.songs.forEach((s) => {
          if (s && s.id) fresh.set(s.id, s);
        });
        emit({ byId: fresh });
      }
      return true;
    } catch {
      emit({ byId: before });
      return false;
    }
  };

  const save = (record) => saveAll([record]);

  return { subscribe, getState: () => state, load, upsert, save, saveAll, hide, restore, remove };
}

export const saved = createSaved();

export function useSaved(selector = (s) => s) {
  return useSyncExternalStore(saved.subscribe, () => selector(saved.getState()));
}
