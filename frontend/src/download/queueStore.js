import { useSyncExternalStore } from "react";
import { rowKey } from "../shared/api.js";

/* ---------------------------------------------------------------------------
   COLA DE DESCARGAS

   Un almacen externo (como jobsStore, engine o playlists): grupos —uno por
   album— con pistas en estado queued/running/done/failed/cancelled. Bajan DOS a
   la vez, FIFO por orden de entrada, sin importar de que grupo venga cada
   pista. La funcion de descarga la pasa quien crea el grupo (la ficha del
   album, en su chunk), asi este modulo sigue siendo puro y pequeno: lo puede
   importar el shell para la pildora sin arrastrar el codigo de descarga.

   No toca window ni document: se importa en Node para los tests.
   ------------------------------------------------------------------------- */

export const QUEUE_LIMIT = 2;

const RUNNING_STATES = new Set(["queued", "running"]);
const isBusy = (state) => RUNNING_STATES.has(state);

export function groupSummary(group) {
  const items = group?.items || [];
  const count = (s) => items.filter((i) => i.state === s).length;
  const done = count("done");
  const failed = count("failed");
  const cancelled = count("cancelled");
  return {
    total: items.length,
    done,
    failed,
    cancelled,
    running: count("running"),
    queued: count("queued"),
    ended: !items.some((i) => isBusy(i.state)),
  };
}

/* El grupo con algo en marcha (el que mira la pildora). */
export const activeGroup = (groups) => groups.find((g) => g.items.some((i) => isBusy(i.state))) || null;

export function createQueueStore() {
  let groups = [];
  let listeners = new Set();
  let active = 0;
  let seq = 0;

  /* Toda mutacion entrega una identidad nueva: useSyncExternalStore solo
     repinta cuando getState cambia, y el estado de una pista cambia aqui. */
  const emit = () => {
    groups = [...groups];
    listeners.forEach((fn) => fn());
  };

  const findGroup = (id) => groups.find((g) => g.id === id);
  const findItem = (id, key) => findGroup(id)?.items.find((i) => i.key === key);

  const alreadyQueued = (key) =>
    groups.some((g) => g.items.some((i) => i.key === key && (isBusy(i.state) || i.state === "done")));

  const checkEnd = (group) => {
    if (group.notified || !groupSummary(group).ended) return;
    group.notified = true;
    group.ended = true;
    group.onFinish?.(group, groupSummary(group));
  };

  const pump = () => {
    while (active < QUEUE_LIMIT) {
      const next = groups
        .flatMap((g) => g.items.filter((i) => i.state === "queued").map((i) => ({ g, i })))
        .sort((a, b) => a.i.seq - b.i.seq)[0];
      if (!next) return;
      const { g, i } = next;
      i.state = "running";
      active += 1;
      emit();
      Promise.resolve()
        .then(() => g.run(i.track, i))
        .then((result) => {
          i.state = "done";
          i.result = result || null;
        })
        .catch((e) => {
          i.state = "failed";
          i.error = e?.message || "falló la descarga";
          i.finished = e?.finished || null;
          i.cookies = e?.cookies === true;
          i.result = null;
        })
        .finally(() => {
          active -= 1;
          checkEnd(g);
          emit();
          pump();
        });
    }
  };

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getState: () => groups,

    /* `tracks` son pistas del mismo album. `downloaded` son claves que la
       ficha ya sabe que estan en la biblioteca: no se encolan otra vez. */
    addGroup({ id, title, artwork_url, tracks, run, onFinish, downloaded }) {
      const have = downloaded instanceof Set ? downloaded : new Set(downloaded || []);
      const fresh = (tracks || []).filter((t) => {
        const key = rowKey(t);
        return !have.has(key) && !alreadyQueued(key);
      });
      if (!fresh.length) return null;
      let group = findGroup(id);
      if (!group) {
        group = { id, title, artwork_url, items: [], notified: false, ended: false };
        groups = [...groups, group];
      }
      group.run = run;
      group.onFinish = onFinish;
      fresh.forEach((track) => {
        group.items.push({ key: rowKey(track), track, state: "queued", seq: ++seq, result: null });
      });
      group.notified = false;
      group.ended = false;
      emit();
      pump();
      return group;
    },

    /* Cancela las que esperan turno; las que ya corren terminan. Sin id,
       cancela las de todos los grupos. */
    cancelPending(id) {
      groups.forEach((g) => {
        if (id != null && g.id !== id) return;
        g.items.forEach((i) => {
          if (i.state === "queued") i.state = "cancelled";
        });
        checkEnd(g);
      });
      emit();
    },

    /* Una pista fallida o cancelada vuelve a la cola, si no la esta bajando ya
       otro grupo. */
    retry(id, key) {
      const group = findGroup(id);
      const item = findItem(id, key);
      if (!group || !item || (item.state !== "failed" && item.state !== "cancelled")) return false;
      if (groups.some((g) => g.items.some((i) => i !== item && i.key === key && isBusy(i.state)))) return false;
      item.state = "queued";
      item.seq = ++seq;
      item.error = null;
      item.finished = null;
      item.cookies = false;
      group.notified = false;
      group.ended = false;
      emit();
      pump();
      return true;
    },

    has(id, key) {
      return Boolean(findItem(id, key));
    },
    getItem(id, key) {
      return findItem(id, key);
    },
  };
}

export const queueStore = createQueueStore();
export const useQueue = () => useSyncExternalStore(queueStore.subscribe, queueStore.getState);
