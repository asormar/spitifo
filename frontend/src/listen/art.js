import { useSyncExternalStore } from "react";
import { API } from "../shared/api.js";
import { sameMap } from "../shared/mapEq.js";

/* ---------------------------------------------------------------------------
   FOTOS PERSONALIZADAS

   Un almacen externo como saved.js: una sola foto inmutable con el registro por
   target, que se reemplaza entera y avisa a los suscriptores. `load` trae
   GET /api/art al arrancar. Los cambios son optimistas: la foto nueva se ve al
   instante (con la URL que traiga la hoja) y vuelve a la anterior si el servidor
   dice que no. Modulo sin window/document aparte del hook: se importa en Node
   para los tests del almacen.
   ------------------------------------------------------------------------- */

const JSON_HEADERS = { "Content-Type": "application/json" };
const EMPTY = { ready: false, error: false, byTarget: new Map() };

export function createArt({ fetchFn = (...a) => fetch(...a) } = {}) {
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
    loading = fetchFn(`${API}/art`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error("http");
        const byTarget = new Map(Object.entries(d.art || {}));
        /* Misma razon que saved.js: una recarga forzada sin fotos nuevas no
           tiene por que invalidar nada que dependa de este Map. */
        emit({ ready: true, error: false, byTarget: sameMap(byTarget, state.byTarget) ? state.byTarget : byTarget });
      })
      .catch(() => emit({ ready: false, error: true }))
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  /* Escritura optimista con deshacer. `record` null es un borrado (reset), que
     el backend devuelve como el mapa entero con el tombstone ya aplicado. La
     URL del candidato se conserva para senalar cual es la "Actual" en la hoja. */
  const write = async (path, body, target, record) => {
    const before = state.byTarget;
    const byTarget = new Map(before);
    if (record) byTarget.set(target, record);
    else byTarget.delete(target);
    emit({ byTarget });
    try {
      const r = await fetchFn(`${API}/art/${path}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("http");
      const d = await r.json().catch(() => ({}));
      const fresh = new Map(state.byTarget);
      if (d.art) {
        fresh.clear();
        Object.entries(d.art).forEach(([t, rec]) => fresh.set(t, rec));
      } else if (d.key) {
        const keepUrl = state.byTarget.get(target)?.url || null;
        fresh.set(target, {
          key: d.key,
          small_key: d.small_key,
          source: d.source,
          ...(keepUrl ? { url: keepUrl } : {}),
        });
      }
      emit({ byTarget: fresh });
      return true;
    } catch {
      emit({ byTarget: before });
      return false;
    }
  };

  const upload = (target, image, small, urls) =>
    write(
      "upload",
      { target, image, small },
      target,
      { pending: true, source: "upload", ...urls }
    );

  const fromUrl = (target, url, source) =>
    write("from-url", { target, url, source }, target, { pending: true, source, url });

  const reset = (target) => write("reset", { target }, target, null);

  return { subscribe, getState: () => state, load, upload, fromUrl, reset };
}

export const art = createArt();

export function useArt(selector = (s) => s) {
  return useSyncExternalStore(art.subscribe, () => selector(art.getState()));
}

/* Cada portada se suscribe SOLO a su target: un cambio de foto no recalcula la
   biblioteca ni repinta las portadas de los demas objetivos. */
export const useArtRecord = (target) => useArt((s) => s.byTarget.get(target));
