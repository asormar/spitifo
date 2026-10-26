import { useSyncExternalStore } from "react";
import { API } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   LISTAS DE REPRODUCCION

   Un almacen externo como el motor (engine.js): una foto inmutable que se
   reemplaza entera y se avisa a los suscriptores. Las vistas leen con
   usePlaylists(selector); el selector debe devolver un valor estable (la foto
   solo cambia cuando cambia algo de verdad).

   ESCRITURAS OPTIMISTAS. Cada cambio se aplica a la foto al instante y despues
   se manda al servidor en segundo plano. Las escrituras de una misma lista van
   en cadena (una promesa por id): una peticion lenta no puede llegar despues
   de otra mas nueva y pisarla. Cada una manda la lista tal como quedo con SU
   cambio, no la ultima foto.

   Si una falla, la lista vuelve a su ultima version confirmada por el servidor
   y las que ya estaban encadenadas detras se descartan (llevan el cambio roto
   dentro): asi lo que se ve y lo que hay guardado coinciden siempre.

   El modulo no toca window ni document para poder importarse en Node.
   ------------------------------------------------------------------------- */

const collator = new Intl.Collator("es", { sensitivity: "base" });
const byName = (a, b) => collator.compare(a.name, b.name);

const MAX_NAME = 100;
const JSON_HEADERS = { "Content-Type": "application/json" };

/* Mueve la clave de la posicion `from` a la posicion que ocupa `to` (indices
   de `keys`). Devuelve el arreglo nuevo, o null si no hay nada que mover. */
export function moveKey(keys, from, to) {
  const last = keys.length - 1;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return null;
  if (from < 0 || to < 0 || from > last || to > last) return null;
  const next = keys.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

/* La lista visible puede saltarse claves que ya no estan en la biblioteca.
   Mover por posicion visible tiene que caer en el sitio correcto de `keys`:
   se traduce cada extremo a la clave que ocupa y de ahi a su indice real. */
export function visibleToKeyIndex(keys, visibleKeys, from, to) {
  return [keys.indexOf(visibleKeys[from]), keys.indexOf(visibleKeys[to])];
}

export function createPlaylists({
  fetchFn = (...a) => fetch(...a),
  now = () => Date.now() / 1000,
  uuid = () => crypto.randomUUID(),
} = {}) {
  let state = { ready: false, error: false, errorCode: null, list: [] };
  const listeners = new Set();
  const errorListeners = new Set();
  /* id -> ultima version que el servidor confirmo. */
  const confirmed = new Map();
  /* id -> { tail, epoch }: cola de escrituras y generacion vigente. */
  const chains = new Map();
  let loading = null;

  const emit = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const onError = (fn) => {
    errorListeners.add(fn);
    return () => errorListeners.delete(fn);
  };
  const find = (id) => state.list.find((p) => p.id === id);

  /* Pone `playlist` en la foto (o la quita si es null) manteniendo el orden. */
  const place = (id, playlist) => {
    const rest = state.list.filter((p) => p.id !== id);
    emit({ list: (playlist ? [...rest, playlist] : rest).sort(byName) });
  };

  const fail = (id, verb, name, code) => {
    place(id, confirmed.get(id) || null);
    const msg =
      code === "reconnect_required"
        ? "Tu sesión de Google Drive ha caducado."
        : `No se pudo ${verb} «${name}». Se deshizo el cambio.`;
    errorListeners.forEach((fn) => fn(msg));
  };

  /* Encadena una escritura: PUT con `body`, o DELETE si es null. */
  const send = (id, body, name) => {
    const chain = chains.get(id) || { tail: Promise.resolve(), epoch: 0 };
    chains.set(id, chain);
    const epoch = chain.epoch;
    chain.tail = chain.tail.then(async () => {
      if (epoch !== chain.epoch) return;
      try {
        const r = await fetchFn(`${API}/playlists/${encodeURIComponent(id)}`, {
          method: body ? "PUT" : "DELETE",
          ...(body && { headers: JSON_HEADERS, body: JSON.stringify(body) }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw Object.assign(new Error("http"), { code: d.code });
        }
        if (body) confirmed.set(id, await r.json());
        else confirmed.delete(id);
      } catch (e) {
        chain.epoch += 1;
        fail(id, body ? "guardar" : "borrar", name, e.code);
      }
    });
  };

  /* Aplica el cambio a la foto y lo manda. `next` es la lista ya cambiada. */
  const write = (next) => {
    const playlist = { ...next, updated_at: now() };
    place(playlist.id, playlist);
    send(playlist.id, { name: playlist.name, keys: playlist.keys }, playlist.name);
  };

  const load = (force = false) => {
    if (loading) return loading;
    if (state.ready && !force) return Promise.resolve();
    loading = fetchFn(`${API}/playlists`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw Object.assign(new Error("http"), { code: d.code });
        confirmed.clear();
        d.playlists.forEach((p) => confirmed.set(p.id, p));
        emit({ ready: true, error: false, errorCode: null, list: [...d.playlists].sort(byName) });
      })
      .catch((e) => emit({ ready: false, error: true, errorCode: e.code || null }))
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  const clean = (name) => String(name ?? "").trim().slice(0, MAX_NAME);

  /* Devuelve el id nuevo, o null si el nombre queda vacio. */
  const create = (name, keys = []) => {
    const n = clean(name);
    if (!n) return null;
    const id = uuid();
    write({ id, name: n, keys: [...new Set(keys)] });
    return id;
  };

  const rename = (id, name) => {
    const p = find(id);
    const n = clean(name);
    if (!p || !n || n === p.name) return false;
    write({ ...p, name: n });
    return true;
  };

  /* Devuelve cuantas claves eran nuevas. */
  const addKeys = (id, keys) => {
    const p = find(id);
    if (!p) return 0;
    const fresh = [...new Set(keys)].filter((k) => !p.keys.includes(k));
    if (fresh.length) write({ ...p, keys: [...p.keys, ...fresh] });
    return fresh.length;
  };

  const removeKey = (id, key) => {
    const p = find(id);
    if (!p || !p.keys.includes(key)) return false;
    write({ ...p, keys: p.keys.filter((k) => k !== key) });
    return true;
  };

  const move = (id, from, to) => {
    const p = find(id);
    const keys = p && moveKey(p.keys, from, to);
    if (!keys) return false;
    write({ ...p, keys });
    return true;
  };

  const remove = (id) => {
    const p = find(id);
    if (!p) return false;
    place(id, null);
    send(id, null, p.name);
    return true;
  };

  /* Borrar deja un tombstone; un PUT con el mismo id lo revive. */
  const undoRemove = (p) => write({ id: p.id, name: p.name, keys: p.keys });

  return {
    subscribe,
    getState: () => state,
    onError,
    load,
    create,
    rename,
    addKeys,
    removeKey,
    move,
    remove,
    undoRemove,
  };
}

export const playlists = createPlaylists();

export function usePlaylists(selector = (s) => s) {
  return useSyncExternalStore(playlists.subscribe, () => selector(playlists.getState()));
}
