import { describe, expect, it, vi } from "vitest";
import { bindStreamPrefetch, nextStreamUrl, shouldPrepare } from "./streamPrefetch.js";

const URL1 = "https://www.youtube.com/watch?v=abcdefghijk";
const URL2 = "https://www.youtube.com/watch?v=abcdefghijl";
const stream = (url) => ({ key: `stream:${url}`, kind: "stream", result: { extra: { webpage_url: url } } });

const state = (playing = true, next = stream(URL2)) => ({
  track: stream(URL1),
  queue: [stream(URL1), next],
  index: 0,
  playing,
});

describe("nextStreamUrl", () => {
  it("reads the next stream from the queue", () => {
    expect(nextStreamUrl(state())).toBe(URL2);
  });

  it("ignores a library next or an empty queue", () => {
    expect(nextStreamUrl(state(true, { key: "lib/x", kind: "library" }))).toBeNull();
    expect(nextStreamUrl({ track: stream(URL1), queue: [], index: -1 })).toBeNull();
  });
});

describe("shouldPrepare", () => {
  it("prepares the next one as soon as the current one plays", () => {
    expect(shouldPrepare(state(false))).toBe(false);
    expect(shouldPrepare(state(true))).toBe(true);
  });

  it("never prepares a library track or a repeated url", () => {
    expect(shouldPrepare({ ...state(), track: { kind: "library", key: "lib/x" } })).toBe(false);
    expect(shouldPrepare(state(), URL2)).toBe(false);
  });
});

describe("bindStreamPrefetch", () => {
  it("posts once and re-arms when the track changes", () => {
    let listener = null;
    let s = state();
    const engine = {
      subscribe(fn) {
        listener = fn;
        return () => { listener = null; };
      },
      getState: () => s,
    };
    const fetchFn = vi.fn(() => Promise.resolve());
    const off = bindStreamPrefetch(engine, { fetchFn });

    listener();
    listener();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith("/api/stream/prepare", {
      method: "POST",
      body: JSON.stringify({ url: URL2 }),
    });

    s = { ...state(), track: stream(URL2), queue: [stream(URL2)], index: 0 };
    listener();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    off();
  });

  it("survives a failing fetch", () => {
    let listener = null;
    const s = state();
    const engine = { subscribe(fn) { listener = fn; return () => {}; }, getState: () => s };
    const fetchFn = vi.fn(() => Promise.reject(new Error("sin red")));
    bindStreamPrefetch(engine, { fetchFn });
    expect(() => listener()).not.toThrow();
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
