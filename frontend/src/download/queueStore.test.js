import { describe, expect, it, vi } from "vitest";
import { QUEUE_LIMIT, createQueueStore, groupSummary } from "./queueStore.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const track = (n) => ({ source: "itunes", source_id: `t${n}`, title: `Canción ${n}` });
const tracks = (n) => Array.from({ length: n }, (_, i) => track(i));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/* Un runner controlado: guarda el orden de arranque y deja cada promesa en
   manos del test para poder comprobar concurrencia y FIFO. */
function controlledRun() {
  const started = [];
  const guards = new Map();
  const run = (t) => {
    started.push(t.source_id);
    const d = deferred();
    guards.set(t.source_id, d);
    return d.promise;
  };
  return { run, started, guards };
}

const add = (store, run, list, extra = {}) =>
  store.addGroup({ id: "album", title: "Canción animal", tracks: list, run, ...extra });

describe("queueStore", () => {
  it("arranca como maximo dos descargas a la vez", async () => {
    const s = createQueueStore();
    const { run, started, guards } = controlledRun();
    add(s, run, tracks(5));
    await flush();
    expect(started).toEqual(["t0", "t1"]);

    guards.get("t0").resolve({ match: "match" });
    await flush();
    expect(started).toEqual(["t0", "t1", "t2"]);
    expect(s.getState()[0].items[0].state).toBe("done");
    expect(s.getState()[0].items[2].state).toBe("running");
  });

  it("respeta FIFO entre grupos: el orden lo da la entrada en la cola", async () => {
    const s = createQueueStore();
    const { run, started, guards } = controlledRun();
    add(s, run, tracks(2));
    add(s, run, [track(2), track(3)]);
    await flush();
    expect(started).toEqual(["t0", "t1"]);
    guards.get("t1").resolve({});
    await flush();
    expect(started).toEqual(["t0", "t1", "t2"]);
    guards.get("t0").resolve({});
    await flush();
    expect(started).toEqual(["t0", "t1", "t2", "t3"]);
  });

  it("no encola dos veces una pista en marcha ni una ya bajada", async () => {
    const s = createQueueStore();
    const { run, started, guards } = controlledRun();
    const first = add(s, run, [track(0), track(1)]);
    await flush();
    expect(started).toEqual(["t0", "t1"]);

    /* Pedir solo la pista en marcha no crea nada; pedirla junto a una nueva
       descarta la duplicada y encola solo la que falta. */
    expect(add(s, run, [track(0)])).toBeNull();
    const second = s.addGroup({ id: "otro", title: "Otro", run, tracks: [track(0), track(2)] });
    expect(second.items.map((i) => i.key)).toEqual(["itunest2"]);
    expect(first.items.length).toBe(2);

    const other = createQueueStore();
    const r2 = controlledRun();
    add(other, r2.run, [track(9)], { downloaded: new Set(["itunest9"]) });
    await flush();
    expect(r2.started).toEqual([]);
    guards.get("t0").resolve({});
    guards.get("t1").resolve({});
  });

  it("cancelPending deja correr las que ya empezaron y cancela el resto", async () => {
    const s = createQueueStore();
    const { run, guards } = controlledRun();
    const onFinish = vi.fn();
    const group = add(s, run, tracks(4), { onFinish });
    await flush();
    s.cancelPending("album");
    expect(group.items.map((i) => i.state)).toEqual(["running", "running", "cancelled", "cancelled"]);
    guards.get("t0").resolve({ match: "match" });
    guards.get("t1").resolve({ match: "partial" });
    await flush();
    expect(group.items.map((i) => i.state)).toEqual(["done", "done", "cancelled", "cancelled"]);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0][1]).toMatchObject({ done: 2, total: 4, failed: 0, cancelled: 2 });
  });

  it("retry devuelve una pista fallida al final de la cola", async () => {
    const s = createQueueStore();
    const { run, started, guards } = controlledRun();
    const group = add(s, run, tracks(3));
    await flush();
    guards.get("t0").reject(new Error("falló la red"));
    await flush();
    expect(group.items[0].state).toBe("failed");
    expect(s.retry("album", "itunest0")).toBe(true);
    await flush();
    expect(group.items[0].state).toBe("queued");
    expect(started).toEqual(["t0", "t1", "t2"]);
    guards.get("t1").resolve({});
    guards.get("t2").resolve({});
    await flush();
    expect(started.at(-1)).toBe("t0");
    expect(group.items[0].state).toBe("running");
    guards.get("t0").resolve({ match: "match" });
    await flush();
    expect(group.items[0].state).toBe("done");
    expect(s.retry("album", "itunest0")).toBe(false);
  });

  it("reenvia el resultado y el veredicto del runner a la pista", async () => {
    const s = createQueueStore();
    const run = vi.fn().mockResolvedValue({ match: "match", filename: "x.mp3" });
    const group = add(s, run, [track(0)]);
    await flush();
    expect(group.items[0].state).toBe("done");
    expect(group.items[0].result).toEqual({ match: "match", filename: "x.mp3" });
    expect(groupSummary(group)).toMatchObject({ done: 1, total: 1, ended: true });
  });

  it("el resumen distingue el exito del fallo parcial", () => {
    const items = ["done", "done", "done", "failed"].map((state) => ({ state }));
    expect(groupSummary({ items })).toMatchObject({ done: 3, failed: 1, total: 4, ended: true });
  });

  it("avisa a los suscriptores y deja de hacerlo al darse de baja", async () => {
    const s = createQueueStore();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    const { run, guards } = controlledRun();
    add(s, run, [track(0)]);
    await flush();
    expect(fn).toHaveBeenCalled();
    const n = fn.mock.calls.length;
    off();
    guards.get("t0").resolve({});
    await flush();
    expect(fn).toHaveBeenCalledTimes(n);
  });

  it("el limite de concurrencia es dos", () => {
    expect(QUEUE_LIMIT).toBe(2);
  });
});
