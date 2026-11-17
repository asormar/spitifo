import { afterEach, describe, expect, it, vi } from "vitest";
import { activeGroup, backoffDelay, createQueueStore, groupItems, groupSummary } from "./queueStore.js";
import { jobsStore } from "./jobsStore.js";
import { verdictStore } from "./verdict.js";

const track = (n) => ({ source: "itunes", source_id: `t${n}`, title: `Canción ${n}` });
const item = (id, status, extra = {}) => ({
  id: String(id),
  track: track(id),
  source: "itunes",
  fmt: "m4a",
  media: "audio",
  status,
  progress: 0,
  query: "q",
  created_at: 1,
  ...extra,
});
const ok = (items) => ({ ok: true, json: async () => ({ items, running: 0, queued: 0 }) });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cola: espera ante un corte de red", () => {
  it("la espera crece hasta 15 s", () => {
    expect([0, 1, 2, 3, 4, 5, 8].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });
});

describe("cola: espejo de GET /api/downloads", () => {
  it("agrupa por grupo y deja cada item sin grupo en el suyo", () => {
    const s = createQueueStore();
    s.applyPayload({
      items: [
        item(1, "downloading", { group: { id: "album:1", title: "Dynamo", artwork_url: "u" } }),
        item(2, "queued", { group: { id: "album:1", title: "Dynamo" } }),
        item(3, "done"),
      ],
    });
    const groups = s.getState().groups;
    expect(groups.map((g) => g.id)).toEqual(["album:1", "single:3"]);
    expect(groups[0].title).toBe("Dynamo");
    expect(groups[0].items.map((i) => i.id)).toEqual(["1", "2"]);
    expect(groups[1].title).toBe("Canción 3");
    expect(groupSummary(groups[0])).toMatchObject({
      total: 2, done: 0, running: 1, queued: 1, ended: false,
    });
    expect(groupSummary(groups[1])).toMatchObject({ total: 1, done: 1, ended: true });
    s.dispose();
  });

  it("publica cada item en jobsStore con la clave de su fila", () => {
    const s = createQueueStore();
    s.applyPayload({ items: [item(4, "downloading", { progress: 62.4, phase: "downloading" })] });
    expect(jobsStore.getJobs().itunest4).toMatchObject({
      status: "downloading", phase: "downloading", progress: 62, title: "Canción 4", key: "itunest4",
    });
    s.dispose();
  });

  it("traduce 'saving' a la fase que entiende el anillo", () => {
    const s = createQueueStore();
    s.applyPayload({ items: [item(5, "saving")] });
    expect(jobsStore.getJobs().itunest5).toMatchObject({ status: "processing", phase: "saving" });
    s.dispose();
  });

  it("el veredicto y el refresco de biblioteca corren UNA vez por pista terminada", () => {
    const s = createQueueStore();
    const onLibrary = vi.fn();
    const onToast = vi.fn();
    const verdict = vi.spyOn(verdictStore, "setFromDownload").mockImplementation(() => {});
    s.setHooks({ onLibrary, onToast });
    const queued = item(6, "queued", {
      group: { id: "album:2", title: "Dynamo" }, match: "match", real_title: "Real",
    });
    const done = { ...queued, status: "done", filename: "x.mp3", size_mb: 4 };
    s.applyPayload({ items: [queued] });
    s.applyPayload({ items: [done] });
    s.applyPayload({ items: [done] });
    expect(verdict).toHaveBeenCalledTimes(1);
    expect(verdict).toHaveBeenCalledWith(queued.track, "q", { match: "match", real_title: "Real" });
    expect(onLibrary).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith("Dynamo: 1 descargada");
    s.dispose();
  });

  it("no avisa al terminar un grupo de una sola pista", () => {
    const s = createQueueStore();
    const onToast = vi.fn();
    s.setHooks({ onToast });
    s.applyPayload({ items: [item(7, "queued")] });
    s.applyPayload({ items: [item(7, "done")] });
    expect(onToast).not.toHaveBeenCalled();
    s.dispose();
  });

  it("resuelve a quien espera el resultado cuando el item llega a done", async () => {
    const s = createQueueStore();
    const p = s.waitForItem("8");
    s.applyPayload({ items: [item(8, "done", { filename: "y.mp3", size_mb: 3, match: "partial" })] });
    await expect(p).resolves.toEqual({ filename: "y.mp3", size_mb: 3, match: "partial", real_title: undefined });
    s.dispose();
  });

  it("un item cancelado rechaza con .cancelled", async () => {
    const s = createQueueStore();
    const p = s.waitForItem("9");
    s.applyPayload({ items: [item(9, "cancelled")] });
    await expect(p).rejects.toMatchObject({ cancelled: true });
    s.dispose();
  });
});

describe("cola: red y reenganche", () => {
  it("marca offline en un fallo y lo quita con la primera respuesta", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(ok([]));
    const s = createQueueStore(fetchImpl);
    await s.pollNow();
    expect(s.getOffline()).toBe(true);
    expect(s.getState().groups).toEqual([]);
    await s.pollNow();
    expect(s.getOffline()).toBe(false);
    s.dispose();
  });

  it("el primer reintento tras un corte es a 1 s, no a 2", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("Failed to fetch"));
    const s = createQueueStore(fetchImpl);
    await s.pollNow();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    s.dispose();
  });

  it("un error de red no borra el ultimo estado conocido", async () => {
    vi.useFakeTimers();
    const busy = item(10, "downloading", { progress: 44 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok([busy]))
      .mockRejectedValueOnce(new Error("Failed to fetch"));
    const s = createQueueStore(fetchImpl);
    await s.pollNow();
    await s.pollNow();
    expect(s.getOffline()).toBe(true);
    expect(s.getState().items[0]).toMatchObject({ status: "downloading", progress: 44 });
    s.dispose();
  });

  it("al abrir avisa una sola vez con las descargas que venian andando", async () => {
    vi.useFakeTimers();
    const onToast = vi.fn();
    const s = createQueueStore(vi.fn().mockResolvedValue(ok([
      item(11, "downloading"),
      item(12, "queued"),
      item(13, "done"),
    ])));
    s.setHooks({ onToast });
    await s.hydrate();
    expect(onToast).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith("Seguimos con 2 descargas que dejaste en marcha.");
    s.dispose();
  });

  it("sin nada pendiente, abrir no deja un sondeo corriendo", async () => {
    vi.useFakeTimers();
    const s = createQueueStore(vi.fn().mockResolvedValue(ok([])));
    await s.hydrate();
    expect(vi.getTimerCount()).toBe(0);
    s.dispose();
  });

  it("hydrate con payload aplica el GET del arranque sin repetirlo", async () => {
    vi.useFakeTimers();
    const onToast = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(ok([]));
    const s = createQueueStore(fetchImpl);
    s.setHooks({ onToast });
    await s.hydrate({ items: [item(30, "downloading")], running: 1, queued: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith("Seguimos con la descarga que dejaste en marcha.");
    expect(s.getState().items[0]).toMatchObject({ id: "30", status: "downloading" });
    s.dispose();
  });
});

describe("cola: un solo sondeo en vuelo", () => {
  it("dos llamadas durante el vuelo hacen dos GET en orden y gana el payload nuevo", async () => {
    const old = deferred();
    const fresh = deferred();
    const fetchImpl = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    const s = createQueueStore(fetchImpl);
    const p1 = s.pollNow();
    const p2 = s.pollNow();
    /* La segunda peticion no sale: se queda con la promesa que ya corre. */
    expect(p2).toBe(p1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    old.resolve(ok([item(40, "queued")]));
    await p1;
    /* Al terminar la primera, el `again` lanza exactamente una pasada mas. */
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    fresh.resolve(ok([item(41, "downloading", { progress: 70 })]));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(s.getState().items.map((i) => i.id)).toEqual(["41"]);
    expect(s.getState().items[0]).toMatchObject({ status: "downloading", progress: 70 });
    s.dispose();
  });

  it("sin red, sin trabajo y sin hoja deja de reintentar tras dos topes de 15 s", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("Failed to fetch"));
    const s = createQueueStore(fetchImpl);
    await s.pollNow();
    for (const ms of [1000, 2000, 4000, 8000, 15000, 15000, 60000]) {
      await vi.advanceTimersByTimeAsync(ms);
    }
    /* 1, 2, 4, 8, 15 y 15: la segunda espera larga no vuelve a programar. */
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
    expect(s.getOffline()).toBe(true);
    /* La siguiente accion del usuario vuelve a sondear. */
    await s.pollNow();
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    s.dispose();
  });
});

describe("groupItems con datos del servidor", () => {
  it("mantiene el orden y el id del grupo entre sondeos", () => {
    const a = item(1, "queued", { group: { id: "album:1", title: "A" } });
    expect(groupItems([a])[0].id).toBe(groupItems([a, item(2, "done")])[0].id);
  });
});

describe("cola: la pildora", () => {
  it("muestra el grupo que esta bajando, no el mas nuevo que espera turno", () => {
    const it = (id, group, status) => ({ id, status, title: id, group: { id: group, title: group } });
    const groups = groupItems([it("a", "Doble vida", "queued"), it("b", "Signos", "downloading"), it("c", "Signos", "queued")]);
    expect(activeGroup(groups).title).toBe("Signos");
    expect(activeGroup(groupItems([it("a", "Doble vida", "queued")])).title).toBe("Doble vida");
    expect(activeGroup(groupItems([it("a", "Doble vida", "done")]))).toBe(null);
  });
});

/* Node no tiene document: el test lo simula para probar visibilitychange. */
const fakeDocument = (state, listeners) => ({
  get visibilityState() {
    return state.value;
  },
  addEventListener: vi.fn((type, fn) => {
    listeners[type] = fn;
  }),
});

describe("cola: pantalla oculta", () => {
  it("con trabajo pendiente y la pantalla apagada no arma el sondeo", async () => {
    vi.useFakeTimers();
    const state = { value: "hidden" };
    const listeners = {};
    vi.stubGlobal("document", fakeDocument(state, listeners));
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    const fetchImpl = vi.fn().mockResolvedValue(ok([]));
    const s = createQueueStore(fetchImpl);
    await s.hydrate({ items: [item(60, "downloading")], running: 1, queued: 0 });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchImpl).not.toHaveBeenCalled();
    s.dispose();
  });

  it("al volver visible sondea enseguida aunque no quedara temporizador", async () => {
    vi.useFakeTimers();
    const state = { value: "hidden" };
    const listeners = {};
    vi.stubGlobal("document", fakeDocument(state, listeners));
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    const fetchImpl = vi.fn().mockResolvedValue(ok([]));
    const s = createQueueStore(fetchImpl);
    await s.hydrate({ items: [item(61, "downloading")], running: 1, queued: 0 });
    expect(vi.getTimerCount()).toBe(0);
    state.value = "visible";
    await listeners.visibilitychange();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    s.dispose();
  });
});

describe("cola: sondeo con plazo", () => {
  it("un GET que no responde aborta a los 10 s, marca offline y permite otro sondeo", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        (url, init) =>
          new Promise((resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("abort")));
          })
      )
      .mockResolvedValueOnce(ok([]));
    const s = createQueueStore(fetchImpl);
    s.pollNow();
    expect(fetchImpl.mock.calls[0][1]).toHaveProperty("signal");
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(s.getOffline()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.getOffline()).toBe(true);
    /* El fallo entra en la espera creciente: primer reintento a 1 s. */
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(s.getOffline()).toBe(false);
    s.dispose();
  });
});
