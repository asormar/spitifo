import { describe, expect, it, vi } from "vitest";
import { createPlaylists, moveKey, visibleToKeyIndex } from "./playlists.js";

/* fetch falso: cada peticion queda en `calls` y se resuelve a mano con
   `settle(i, ...)`, para controlar el orden en que "llega" cada respuesta. */
function setup() {
  const calls = [];
  const fetchFn = (url, init = {}) =>
    new Promise((resolve) => {
      calls.push({
        url,
        method: init.method || "GET",
        body: init.body ? JSON.parse(init.body) : null,
        resolve,
      });
    });
  let n = 0;
  const store = createPlaylists({
    fetchFn,
    now: () => 1000 + ++n,
    uuid: () => `id-${++n}`,
  });
  const errors = [];
  store.onError((m) => errors.push(m));
  return { store, calls, errors };
}

const json = (status, data) => ({
  ok: status < 400,
  status,
  json: async () => data,
});
const saved = (call, extra = {}) => json(200, { id: "x", updated_at: 1, ...call.body, ...extra });
const tick = () => new Promise((r) => setTimeout(r, 0));

const P = (id, name, keys = []) => ({ id, name, keys, updated_at: 1 });

async function loaded(lists) {
  const t = setup();
  const done = t.store.load();
  t.calls[0].resolve(json(200, { playlists: lists }));
  await done;
  return t;
}

describe("load", () => {
  it("fills the list sorted by name and marks it ready", async () => {
    const { store, calls } = await loaded([P("b", "ñu"), P("a", "Álbum"), P("c", "casa")]);
    expect(calls[0].url).toBe("/api/playlists");
    const s = store.getState();
    expect(s.ready).toBe(true);
    expect(s.error).toBe(false);
    expect(s.list.map((p) => p.name)).toEqual(["Álbum", "casa", "ñu"]);
  });

  it("keeps the error code so the view can offer reconnecting", async () => {
    const { store, calls } = setup();
    const done = store.load();
    calls[0].resolve(json(503, { code: "reconnect_required" }));
    await done;
    expect(store.getState()).toMatchObject({ ready: false, error: true, errorCode: "reconnect_required" });
  });

  it("flags a network failure and recovers on retry", async () => {
    const { store, calls } = setup();
    const first = store.load();
    calls[0].resolve(Promise.reject(new TypeError("Failed to fetch")));
    await first;
    expect(store.getState()).toMatchObject({ ready: false, error: true, errorCode: null });
    const retry = store.load();
    calls[1].resolve(json(200, { playlists: [P("a", "A")] }));
    await retry;
    expect(store.getState()).toMatchObject({ ready: true, error: false });
  });

  it("does not repeat the request while loading or once ready", async () => {
    const { store, calls } = setup();
    const a = store.load();
    store.load();
    expect(calls).toHaveLength(1);
    calls[0].resolve(json(200, { playlists: [] }));
    await a;
    await store.load();
    expect(calls).toHaveLength(1);
    store.load(true);
    expect(calls).toHaveLength(2);
  });
});

describe("create", () => {
  it("is visible before the PUT resolves and confirms afterwards", async () => {
    const { store, calls } = await loaded([]);
    const id = store.create("  Mi lista ", ["k1", "k1", "k2"]);
    expect(store.getState().list).toMatchObject([{ id, name: "Mi lista", keys: ["k1", "k2"] }]);
    await tick();
    expect(calls[1]).toMatchObject({
      method: "PUT",
      url: `/api/playlists/${id}`,
      body: { name: "Mi lista", keys: ["k1", "k2"] },
    });
    calls[1].resolve(saved(calls[1], { id }));
    await tick();
    expect(store.getState().list[0].id).toBe(id);
  });

  it("refuses an empty name", async () => {
    const { store, calls } = await loaded([]);
    expect(store.create("   ")).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("editing", () => {
  it("addKeys skips the keys already present and counts the new ones", async () => {
    const { store, calls } = await loaded([P("a", "A", ["k1"])]);
    expect(store.addKeys("a", ["k1", "k2", "k2", "k3"])).toBe(2);
    expect(store.getState().list[0].keys).toEqual(["k1", "k2", "k3"]);
    expect(store.addKeys("a", ["k1"])).toBe(0);
    expect(store.addKeys("nope", ["k1"])).toBe(0);
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].body.keys).toEqual(["k1", "k2", "k3"]);
  });

  it("removeKey and move change the order and send the result", async () => {
    const { store, calls } = await loaded([P("a", "A", ["x", "y", "z"])]);
    expect(store.move("a", 0, 2)).toBe(true);
    expect(store.getState().list[0].keys).toEqual(["y", "z", "x"]);
    expect(store.move("a", 1, 1)).toBe(false);
    expect(store.move("a", 0, 9)).toBe(false);
    expect(store.removeKey("a", "z")).toBe(true);
    expect(store.removeKey("a", "z")).toBe(false);
    expect(store.getState().list[0].keys).toEqual(["y", "x"]);
    await tick();
    expect(calls[1].body.keys).toEqual(["y", "z", "x"]);
  });

  it("rename keeps the list sorted and trims the name", async () => {
    const { store } = await loaded([P("a", "Alfa"), P("b", "Beta")]);
    expect(store.rename("a", " Zeta ")).toBe(true);
    expect(store.getState().list.map((p) => p.name)).toEqual(["Beta", "Zeta"]);
    expect(store.rename("a", "Zeta")).toBe(false);
    expect(store.rename("a", "  ")).toBe(false);
  });
});

describe("failures", () => {
  it("reverts to the confirmed version and reports it", async () => {
    const { store, calls, errors } = await loaded([P("a", "Alfa", ["k1"])]);
    store.addKeys("a", ["k2"]);
    await tick();
    calls[1].resolve(json(500, {}));
    await tick();
    expect(store.getState().list[0].keys).toEqual(["k1"]);
    expect(errors).toEqual(["No se pudo guardar «Alfa». Se deshizo el cambio."]);
  });

  it("drops a playlist that never reached the server", async () => {
    const { store, calls, errors } = await loaded([]);
    store.create("Nueva");
    await tick();
    calls[1].resolve(Promise.reject(new TypeError("Failed to fetch")));
    await tick();
    expect(store.getState().list).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("explains an expired Drive session", async () => {
    const { store, calls, errors } = await loaded([P("a", "Alfa")]);
    store.rename("a", "Otra");
    await tick();
    calls[1].resolve(json(503, { code: "reconnect_required" }));
    await tick();
    expect(errors).toEqual(["Tu sesión de Google Drive ha caducado."]);
    expect(store.getState().list[0].name).toBe("Alfa");
  });

  it("discards the writes queued behind a failed one", async () => {
    const { store, calls, errors } = await loaded([P("a", "Alfa", ["k1"])]);
    store.addKeys("a", ["k2"]);
    store.addKeys("a", ["k3"]);
    await tick();
    calls[1].resolve(json(500, {}));
    await tick();
    expect(calls).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(store.getState().list[0].keys).toEqual(["k1"]);
  });

  it("a change made after the failure is sent normally", async () => {
    const { store, calls } = await loaded([P("a", "Alfa", ["k1"])]);
    store.addKeys("a", ["k2"]);
    await tick();
    calls[1].resolve(json(500, {}));
    await tick();
    store.addKeys("a", ["k3"]);
    await tick();
    expect(calls[2].body.keys).toEqual(["k1", "k3"]);
  });
});

describe("ordering", () => {
  it("sends two quick writes to the same id in order", async () => {
    const { store, calls } = await loaded([P("a", "Alfa", [])]);
    store.addKeys("a", ["k1"]);
    store.addKeys("a", ["k2"]);
    expect(store.getState().list[0].keys).toEqual(["k1", "k2"]);
    await tick();
    /* La segunda no sale hasta que la primera responde. */
    expect(calls).toHaveLength(2);
    expect(calls[1].body.keys).toEqual(["k1"]);
    calls[1].resolve(saved(calls[1], { id: "a" }));
    await tick();
    expect(calls).toHaveLength(3);
    expect(calls[2].body.keys).toEqual(["k1", "k2"]);
    calls[2].resolve(saved(calls[2], { id: "a" }));
    await tick();
    expect(store.getState().list[0].keys).toEqual(["k1", "k2"]);
  });

  it("does not hold back writes to other playlists", async () => {
    const { store, calls } = await loaded([P("a", "A"), P("b", "B")]);
    store.addKeys("a", ["k1"]);
    store.addKeys("b", ["k1"]);
    await tick();
    expect(calls.slice(1).map((c) => c.url)).toEqual(["/api/playlists/a", "/api/playlists/b"]);
  });
});

describe("remove and undo", () => {
  it("DELETEs, then a PUT with the same id brings it back", async () => {
    const original = P("a", "Alfa", ["k1", "k2"]);
    const { store, calls } = await loaded([original]);
    expect(store.remove("a")).toBe(true);
    expect(store.getState().list).toEqual([]);
    await tick();
    expect(calls[1]).toMatchObject({ method: "DELETE", url: "/api/playlists/a" });
    calls[1].resolve({ ok: true, status: 204, json: async () => ({}) });
    await tick();

    store.undoRemove(original);
    expect(store.getState().list.map((p) => p.id)).toEqual(["a"]);
    await tick();
    expect(calls[2]).toMatchObject({
      method: "PUT",
      url: "/api/playlists/a",
      body: { name: "Alfa", keys: ["k1", "k2"] },
    });
  });

  it("an undo issued while the DELETE is in flight waits for it", async () => {
    const original = P("a", "Alfa", ["k1"]);
    const { store, calls } = await loaded([original]);
    store.remove("a");
    store.undoRemove(original);
    await tick();
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    calls[1].resolve({ ok: true, status: 204, json: async () => ({}) });
    await tick();
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE", "PUT"]);
  });

  it("a failed DELETE brings the playlist back", async () => {
    const { store, calls, errors } = await loaded([P("a", "Alfa", ["k1"])]);
    store.remove("a");
    await tick();
    calls[1].resolve(json(500, {}));
    await tick();
    expect(store.getState().list.map((p) => p.id)).toEqual(["a"]);
    expect(errors).toEqual(["No se pudo borrar «Alfa». Se deshizo el cambio."]);
  });
});

describe("pure helpers", () => {
  it("moveKey moves to the position of the target", () => {
    expect(moveKey(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveKey(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(moveKey(["a", "b"], 0, 0)).toBeNull();
    expect(moveKey(["a", "b"], 0, 2)).toBeNull();
  });

  it("maps visible positions to key indices when keys are missing", () => {
    /* "m1" y "m2" ya no estan en la biblioteca: no se ven, pero siguen. */
    const keys = ["a", "m1", "b", "m2", "c"];
    const visible = ["a", "b", "c"];
    const [from, to] = visibleToKeyIndex(keys, visible, 0, 2);
    expect([from, to]).toEqual([0, 4]);
    expect(moveKey(keys, from, to)).toEqual(["m1", "b", "m2", "c", "a"]);
    const [f2, t2] = visibleToKeyIndex(keys, visible, 2, 1);
    expect(moveKey(keys, f2, t2)).toEqual(["a", "m1", "c", "b", "m2"]);
  });
});

describe("subscribers", () => {
  it("notify on every change and stop after unsubscribing", async () => {
    const { store } = await loaded([P("a", "A")]);
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.addKeys("a", ["k"]);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    store.addKeys("a", ["j"]);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
