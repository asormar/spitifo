import { describe, expect, it, vi } from "vitest";
import { bindStreamPrefetch, nextStreamUrl, PREPARE_WINDOW_S, shouldPrepare } from "./streamPrefetch.js";

const URL1 = "https://www.youtube.com/watch?v=abcdefghijk";
const URL2 = "https://www.youtube.com/watch?v=abcdefghijl";
const stream = (url) => ({ key: `stream:${url}`, kind: "stream", result: { extra: { webpage_url: url } } });

const state = (time = 100, next = stream(URL2)) => ({
  track: stream(URL1),
  queue: [stream(URL1), next],
  index: 0,
  duration: 120,
  time,
});

describe("nextStreamUrl", () => {
  it("reads the next stream from the queue", () => {
    expect(nextStreamUrl(state())).toBe(URL2);
  });

  it("ignores a library next or an empty queue", () => {
    expect(nextStreamUrl(state(100, { key: "lib/x", kind: "library" }))).toBeNull();
    expect(nextStreamUrl({ track: stream(URL1), queue: [], index: -1 })).toBeNull();
  });
});

describe("shouldPrepare", () => {
  it("waits until the window at the end of the song", () => {
    expect(shouldPrepare(state(99))).toBe(false);
    expect(shouldPrepare(state(120 - PREPARE_WINDOW_S))).toBe(true);
    expect(shouldPrepare(state(119))).toBe(true);
  });

  it("never prepares a library track or a repeated url", () => {
    expect(shouldPrepare({ ...state(119), track: { kind: "library", key: "lib/x" } })).toBe(false);
    expect(shouldPrepare(state(119), URL2)).toBe(false);
  });

  it("does nothing without a duration", () => {
    expect(shouldPrepare({ ...state(119), duration: 0 })).toBe(false);
  });
});

describe("bindStreamPrefetch", () => {
  it("posts once and re-arms when the track changes", () => {
    let listener = null;
    let s = state(119);
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

    s = { ...state(119), track: stream(URL2), queue: [stream(URL2)], index: 0 };
    listener();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    off();
  });

  it("survives a failing fetch", () => {
    let listener = null;
    const s = state(119);
    const engine = { subscribe(fn) { listener = fn; return () => {}; }, getState: () => s };
    const fetchFn = vi.fn(() => Promise.reject(new Error("sin red")));
    bindStreamPrefetch(engine, { fetchFn });
    expect(() => listener()).not.toThrow();
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
