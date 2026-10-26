import { describe, expect, it } from "vitest";
import {
  continueListening,
  createHistory,
  mostPlayed,
} from "./history.js";

const json = (status, data) => ({
  ok: status < 400,
  status,
  json: async () => data,
});

function setup(response) {
  const calls = [];
  const store = createHistory({
    fetchFn: async (url) => {
      calls.push(url);
      return response;
    },
    now: () => 1000,
    cache: null,
  });
  return { store, calls };
}

const event = (patch = {}) => ({
  t: 1000,
  k: "A/A - Uno.mp3",
  d: 200_000,
  l: 200_000,
  p: 200_000,
  r: "end",
  o: "play",
  ...patch,
});

describe("load", () => {
  it("fills tracks and recent and marks the store ready", async () => {
    const { store, calls } = setup(json(200, {
      tracks: { k: { plays: 2, skips: 0, listened_ms: 1, last: 1, score: 1, pos: 1, dur: 2 } },
      recent: [{ key: "k", last: 1, pos: 1, dur: 2, o: "play" }],
    }));
    await store.load();
    expect(calls).toEqual(["/api/listens/summary"]);
    expect(store.getState()).toMatchObject({
      ready: true,
      error: false,
      tracks: { k: { plays: 2 } },
      recent: [{ key: "k" }],
    });
  });

  it("does not repeat the request once ready unless forced", async () => {
    const { store, calls } = setup(json(200, { tracks: {}, recent: [] }));
    await store.load();
    await store.load();
    expect(calls).toHaveLength(1);
    await store.load(true);
    expect(calls).toHaveLength(2);
  });

  it("flags a failure", async () => {
    const { store } = setup(json(500, {}));
    await store.load();
    expect(store.getState()).toMatchObject({ ready: false, error: true });
  });
});

describe("record", () => {
  it("applies a play immediately and moves the key to the front", () => {
    const { store } = setup(json(200, {}));
    store.record(event({ t: 10, k: "viejo", last: 10 }));
    store.record(event({ t: 20, k: "nuevo", l: 5_000, p: 5_000, o: "partial" }));
    expect(store.getState().recent.map((e) => e.key)).toEqual(["nuevo", "viejo"]);
    expect(store.getState().tracks.nuevo).toMatchObject({
      plays: 0,
      listened_ms: 5_000,
      last: 20,
      pos: 5_000,
      dur: 200_000,
    });
  });

  it("bumps plays and skips and keeps a distinct recent", () => {
    const { store } = setup(json(200, {}));
    store.record(event({ t: 10, k: "k" }));
    store.record(event({ t: 20, k: "k", o: "skip", r: "next", l: 1_000, p: 1_000 }));
    const state = store.getState();
    expect(state.tracks.k).toMatchObject({ plays: 1, skips: 1, last: 20 });
    expect(state.recent).toEqual([
      { key: "k", last: 20, pos: 1_000, dur: 200_000, o: "skip" },
    ]);
  });

  it("ignores events without a key", () => {
    const { store } = setup(json(200, {}));
    expect(store.record({})).toBe(false);
    expect(store.getState().recent).toEqual([]);
  });
});

describe("selectors", () => {
  const state = {
    tracks: {
      a: { plays: 3, last: 10 },
      b: { plays: 3, last: 20 },
      c: { plays: 1, last: 30 },
      d: { plays: 0, last: 40 },
    },
    recent: [
      { key: "c", pos: 199_000, dur: 200_000, last: 30 },
      { key: "b", pos: 50_000, dur: 200_000, last: 20 },
      { key: "a", pos: 10_000, dur: 200_000, last: 10 },
    ],
  };

  it("continueListening keeps the unfinished ones, newest first", () => {
    expect(continueListening(state, 5).map((e) => e.key)).toEqual(["b", "a"]);
    expect(continueListening(state, 1).map((e) => e.key)).toEqual(["b"]);
  });

  it("continueListening falls back to the last played", () => {
    const finished = {
      ...state,
      recent: [{ key: "c", pos: 200_000, dur: 200_000, last: 30 }],
    };
    expect(continueListening(finished).map((e) => e.key)).toEqual(["c"]);
  });

  it("mostPlayed sorts by plays and then by last", () => {
    expect(mostPlayed(state, 5)).toEqual(["b", "a", "c", "d"]);
    expect(mostPlayed(state, 2)).toEqual(["b", "a"]);
  });
});

describe("history cache", () => {
  const memoryCache = (initial) => {
    let saved = initial;
    return { read: () => saved, write: (v) => { saved = v; }, saved: () => saved };
  };

  it("starts from the previous snapshot before the summary arrives", () => {
    const cache = memoryCache({ tracks: { "A/A - Uno.mp3": { plays: 2 } }, recent: [{ key: "A/A - Uno.mp3" }] });
    const store = createHistory({ fetchFn: async () => json(200, {}), cache });
    expect(store.getState()).toMatchObject({ ready: false, recent: [{ key: "A/A - Uno.mp3" }] });
  });

  it("saves what it loads and what it records", async () => {
    const cache = memoryCache(null);
    const store = createHistory({
      fetchFn: async () => json(200, { tracks: {}, recent: [] }),
      now: () => 1000,
      cache,
    });
    await store.load();
    store.record(event());
    expect(cache.saved().recent[0].key).toBe("A/A - Uno.mp3");
  });

  it("ignores a broken snapshot", () => {
    const store = createHistory({ fetchFn: async () => json(200, {}), cache: memoryCache({ tracks: 3, recent: "x" }) });
    expect(store.getState()).toMatchObject({ tracks: {}, recent: [] });
  });
});
