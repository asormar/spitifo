import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POLL_MS,
  becauseText,
  cleanArtists,
  cleanGenres,
  cleanStatus,
  createReco,
  visibleArtists,
} from "./reco.js";

const json = (status, data) => ({ ok: status < 400, status, json: async () => data });
const tick = () => new Promise((r) => setTimeout(r, 0));

const A = (name, extra = {}) => ({
  name,
  mbid: null,
  score: 0.5,
  because: ["Linkin Park"],
  genres: ["nu metal"],
  ...extra,
});
const payload = (extra = {}) => ({
  status: { done: 13, total: 13, running: false, offline: false },
  genres: [{ name: "reggaeton", share: 0.6 }],
  artists: [A("Duki"), A("Trueno"), A("Papa Roach")],
  ...extra,
});

/* Cada peticion queda en `calls`; las GET responden con `replies` en orden y los
   POST con `post`. */
function setup({ replies = [payload()], post = () => json(200, { ok: true }), cache = null } = {}) {
  const calls = [];
  let n = 0;
  const fetchFn = async (url, init = {}) => {
    const call = { url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (call.method === "POST") return post(call);
    const reply = replies[Math.min(n, replies.length - 1)];
    n += 1;
    return typeof reply === "function" ? reply() : json(200, reply);
  };
  const timers = [];
  const store = createReco({
    fetchFn,
    cache,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: (id) => {
      if (timers[id - 1]) timers[id - 1].dead = true;
    },
  });
  const errors = [];
  store.onError((m) => errors.push(m));
  const pending = () => timers.filter((t) => !t.dead && !t.ran);
  const fire = async () => {
    const t = pending()[0];
    t.ran = true;
    t.fn();
    await tick();
  };
  return { store, calls, errors, timers, pending, fire };
}

afterEach(() => vi.restoreAllMocks());

describe("cleaners", () => {
  it("clean the status and fall back to idle", () => {
    expect(cleanStatus({ done: 3, total: 9, running: true, offline: false })).toEqual({
      done: 3,
      total: 9,
      running: true,
      offline: false,
    });
    expect(cleanStatus(null)).toEqual({ done: 0, total: 0, running: false, offline: false });
    expect(cleanStatus({ done: -2, total: "x", running: "yes" })).toEqual({
      done: 0,
      total: 0,
      running: false,
      offline: false,
    });
  });

  it("keeps only well-formed genres and artists", () => {
    expect(cleanGenres([{ name: "a", share: 0.4 }, { name: "", share: 1 }, { name: "b" }, null])).toEqual([
      { name: "a", share: 0.4 },
    ]);
    expect(cleanGenres("nope")).toEqual([]);
    const out = cleanArtists([A("Duki"), A("Duki"), { name: "  " }, { name: "X", because: "no", genres: [1, "g"] }, 7]);
    expect(out.map((a) => a.name)).toEqual(["Duki", "X"]);
    expect(out[1]).toMatchObject({ because: [], genres: ["g"], mbid: null, score: 0 });
  });

  it("filters hidden artists", () => {
    const list = [A("a"), A("b"), A("c")];
    expect(visibleArtists(list, ["b"]).map((x) => x.name)).toEqual(["a", "c"]);
    expect(visibleArtists(list, [])).toBe(list);
  });

  it("words the reason with the first two artists", () => {
    expect(becauseText(["Milo j", "Bizarrap", "Otro"])).toBe("Porque escuchas Milo j y Bizarrap");
    expect(becauseText(["Don Omar"])).toBe("Porque escuchas Don Omar");
    expect(becauseText([])).toBe("");
    expect(becauseText(undefined)).toBe("");
  });
});

describe("loading", () => {
  it("fills the snapshot from /api/discover", async () => {
    const t = setup();
    await t.store.load();
    const s = t.store.getState();
    expect(t.calls[0]).toMatchObject({ url: "/api/discover", method: "GET" });
    expect(s.ready).toBe(true);
    expect(s.artists.map((a) => a.name)).toEqual(["Duki", "Trueno", "Papa Roach"]);
    expect(s.genres).toEqual([{ name: "reggaeton", share: 0.6 }]);
  });

  it("paints the last snapshot at once and replaces it with the real one", async () => {
    const store = new Map();
    const cache = {
      read: () => store.get("k") ?? null,
      write: (v) => store.set("k", v),
    };
    const first = setup({ cache });
    await first.store.load();
    expect(store.get("k").artists).toHaveLength(3);

    const second = setup({ cache, replies: [payload({ artists: [A("Nuevo")] })] });
    expect(second.store.getState().ready).toBe(false);
    expect(second.store.getState().artists.map((a) => a.name)).toEqual(["Duki", "Trueno", "Papa Roach"]);
    await second.store.load();
    expect(second.store.getState().artists.map((a) => a.name)).toEqual(["Nuevo"]);
  });

  it("tolerates a corrupt cache", () => {
    const t = setup({ cache: { read: () => ({ genres: 4, artists: "x" }), write: () => {} } });
    expect(t.store.getState().artists).toEqual([]);
    expect(t.store.getState().genres).toEqual([]);
  });

  it("marks an error and keeps what it had", async () => {
    const t = setup({ replies: [payload(), () => json(500, {})] });
    await t.store.load();
    await t.store.load(true);
    const s = t.store.getState();
    expect(s.error).toBe(true);
    expect(s.artists).toHaveLength(3);
  });

  it("does not ask twice for the same visit unless forced", async () => {
    const t = setup();
    await t.store.load();
    await t.store.load();
    expect(t.calls).toHaveLength(1);
    await t.store.load(true);
    expect(t.calls).toHaveLength(2);
  });

  it("shares one request while another is in flight", async () => {
    const t = setup();
    await Promise.all([t.store.load(true), t.store.load(true)]);
    expect(t.calls).toHaveLength(1);
  });
});

describe("polling", () => {
  const running = (done) =>
    payload({ status: { done, total: 13, running: true, offline: false }, artists: [] });

  it("polls every 4 s only while the server is still working", async () => {
    const t = setup({ replies: [running(3), running(9), payload()] });
    const stop = t.store.watch();
    await tick();
    expect(t.calls).toHaveLength(1);
    expect(t.pending()).toHaveLength(1);
    expect(t.pending()[0].ms).toBe(POLL_MS);
    expect(POLL_MS).toBe(4000);

    await t.fire();
    expect(t.calls).toHaveLength(2);
    expect(t.store.getState().status.done).toBe(9);
    expect(t.pending()).toHaveLength(1);

    await t.fire();
    expect(t.calls).toHaveLength(3);
    expect(t.store.getState().status.running).toBe(false);
    /* Terminó: no hay otra consulta programada. */
    expect(t.pending()).toHaveLength(0);
    stop();
  });

  it("does not poll when nobody is watching", async () => {
    const t = setup({ replies: [running(1)] });
    await t.store.load(true);
    expect(t.pending()).toHaveLength(0);
  });

  it("stops polling when the last watcher leaves", async () => {
    const t = setup({ replies: [running(1)] });
    const stop = t.store.watch();
    await tick();
    expect(t.pending()).toHaveLength(1);
    stop();
    expect(t.pending()).toHaveLength(0);
    stop();
    expect(t.store.getState().ready).toBe(true);
  });

  it("asks once per visit", async () => {
    const t = setup();
    const stop = t.store.watch();
    await tick();
    stop();
    const again = t.store.watch();
    await tick();
    expect(t.calls).toHaveLength(2);
    again();
  });

  it("keeps trying after a failed poll while it was running", async () => {
    const t = setup({ replies: [running(1), () => json(500, {}), running(5)] });
    const stop = t.store.watch();
    await tick();
    await t.fire();
    expect(t.store.getState().error).toBe(true);
    expect(t.pending()).toHaveLength(1);
    await t.fire();
    expect(t.store.getState().error).toBe(false);
    stop();
  });
});

describe("dismissing", () => {
  const loaded = async (opts) => {
    const t = setup(opts);
    await t.store.load();
    return t;
  };
  const names = (t) => visibleArtists(t.store.getState().artists, t.store.getState().hidden).map((a) => a.name);

  it("hides the artist at once and tells the server", async () => {
    const t = await loaded();
    expect(t.store.dismiss("Trueno")).toBe(true);
    expect(names(t)).toEqual(["Duki", "Papa Roach"]);
    await tick();
    const post = t.calls.find((c) => c.method === "POST");
    expect(post).toMatchObject({ url: "/api/discover/dismiss", body: { name: "Trueno" } });
  });

  it("ignores an artist that is not a candidate or is already hidden", async () => {
    const t = await loaded();
    expect(t.store.dismiss("Nadie")).toBe(false);
    expect(t.store.dismiss("Duki")).toBe(true);
    expect(t.store.dismiss("Duki")).toBe(false);
  });

  it("undoes: the artist is back in its place and the server hears it", async () => {
    const t = await loaded();
    t.store.dismiss("Trueno");
    expect(t.store.undo("Trueno")).toBe(true);
    expect(names(t)).toEqual(["Duki", "Trueno", "Papa Roach"]);
    await tick();
    await tick();
    const posts = t.calls.filter((c) => c.method === "POST").map((c) => c.body);
    expect(posts).toEqual([{ name: "Trueno" }, { name: "Trueno", undo: true }]);
    expect(t.store.undo("Trueno")).toBe(false);
  });

  it("sends the dismiss before the undo even if the first one is slow", async () => {
    const order = [];
    let release;
    const gate = new Promise((r) => (release = r));
    const t = await loaded({
      post: async (call) => {
        if (!call.body.undo) await gate;
        order.push(call.body.undo ? "undo" : "dismiss");
        return json(200, { ok: true });
      },
    });
    t.store.dismiss("Duki");
    t.store.undo("Duki");
    await tick();
    release();
    await tick();
    await tick();
    expect(order).toEqual(["dismiss", "undo"]);
  });

  it("brings the artist back and reports when the server refuses", async () => {
    const t = await loaded({ post: () => json(500, {}) });
    t.store.dismiss("Duki");
    expect(names(t)).not.toContain("Duki");
    await tick();
    await tick();
    expect(names(t)).toContain("Duki");
    expect(t.errors).toEqual(["No se pudo ocultar «Duki». Se deshizo el cambio."]);
  });

  it("does not resurrect a hidden artist from a later reply", async () => {
    const t = await loaded({ replies: [payload(), payload()] });
    t.store.dismiss("Duki");
    await t.store.load(true);
    expect(names(t)).toEqual(["Trueno", "Papa Roach"]);
  });

  it("restores everything hidden in this session", async () => {
    const t = await loaded();
    t.store.dismiss("Duki");
    t.store.dismiss("Trueno");
    t.store.restoreAll();
    expect(names(t)).toEqual(["Duki", "Trueno", "Papa Roach"]);
    await tick();
    await tick();
    expect(t.calls.filter((c) => c.method === "POST" && c.body.undo)).toHaveLength(2);
  });

  it("keeps hidden artists out of the saved snapshot", async () => {
    const saved = [];
    const t = await loaded({ cache: { read: () => null, write: (v) => saved.push(v) } });
    t.store.dismiss("Duki");
    expect(saved.at(-1).artists.map((a) => a.name)).toEqual(["Trueno", "Papa Roach"]);
    t.store.undo("Duki");
    expect(saved.at(-1).artists.map((a) => a.name)).toEqual(["Duki", "Trueno", "Papa Roach"]);
  });
});
