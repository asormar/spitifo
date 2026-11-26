import { describe, expect, it, vi } from "vitest";
import { bindStreamPrefetch, nextStreamUrl, nextStreamUrls, shouldPrepare, shouldPrepareAhead } from "./streamPrefetch.js";

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

const URL3 = "https://www.youtube.com/watch?v=abcdefghijm";

describe("nextStreamUrls (P-time-to-audio-5)", () => {
  it("prepares up to two upcoming streams, not just the next one", () => {
    const s = {
      ...state(),
      queue: [stream(URL1), stream(URL2), stream(URL3)],
    };
    expect(nextStreamUrls(s)).toEqual([URL2, URL3]);
  });

  it("skip streams already prepared and non-stream tracks", () => {
    const s = {
      ...state(),
      queue: [stream(URL1), stream(URL2), { key: "lib/x", kind: "library" }, stream(URL3)],
    };
    expect(nextStreamUrls(s, new Set([URL2]))).toEqual([URL3]);
  });

  it("warms a stream after a library track too", () => {
    const s = {
      track: { key: "lib/x", kind: "library" },
      queue: [{ key: "lib/x", kind: "library" }, stream(URL2)],
      index: 0,
      playing: true,
    };
    expect(shouldPrepareAhead(s)).toEqual([URL2]);
    expect(shouldPrepareAhead({ ...s, playing: false, buffering: false })).toEqual([]);
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
