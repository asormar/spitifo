import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAndroidMedia } from "./androidMedia.js";

const A = {
  key: "a",
  title: "Song A",
  meta: "Artist A",
  artwork: "/api/audio?key=a.jpg",
  duration: 200,
  kind: "library",
};
const B = { ...A, key: "b", title: "Song B", artwork: null };

const baseState = (over = {}) => ({
  track: A,
  queue: [A, B],
  index: 0,
  playing: true,
  buffering: false,
  time: 10,
  duration: 200,
  ...over,
});

function fakeEngine(initial = baseState()) {
  let state = initial;
  const subscribers = new Set();
  const seekers = new Set();
  return {
    getState: () => state,
    subscribe: vi.fn((fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    }),
    onSeek: vi.fn((fn) => {
      seekers.add(fn);
      return () => seekers.delete(fn);
    }),
    set(patch) {
      state = { ...state, ...patch };
      subscribers.forEach((fn) => fn());
    },
    seek: vi.fn((seconds) => {
      /* El motor real avisa antes de emitir: el puente marca esa vuelta como
         forzada y manda la posicion sin esperar al throttling. */
      seekers.forEach((fn) => fn(seconds));
      state = { ...state, time: seconds };
      subscribers.forEach((fn) => fn());
    }),
    resume: vi.fn(),
    pause: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
  };
}

let listeners;
let bridge;
let view;

beforeEach(() => {
  listeners = new Map();
  bridge = { mediaUpdate: vi.fn(), mediaClear: vi.fn() };
  view = {
    SpitifoAndroid: bridge,
    addEventListener: vi.fn((type, fn) => {
      listeners.set(type, [...(listeners.get(type) || []), fn]);
    }),
    removeEventListener: vi.fn((type, fn) => {
      listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn));
    }),
  };
  vi.stubGlobal("window", view);
});

afterEach(() => vi.unstubAllGlobals());

const fire = (detail) =>
  (listeners.get("spitifo-media") || []).forEach((fn) => fn({ detail }));

const payloads = () => bridge.mediaUpdate.mock.calls.map(([json]) => JSON.parse(json));

describe("bindAndroidMedia", () => {
  it("does nothing when the native bridge is absent", () => {
    view.SpitifoAndroid = { mediaClear: vi.fn() };
    const engine = fakeEngine();
    const off = bindAndroidMedia(engine);
    expect(engine.subscribe).not.toHaveBeenCalled();
    engine.set({ playing: false });
    off();
  });

  it("sends the first snapshot with the contract fields", () => {
    const engine = fakeEngine();
    bindAndroidMedia(engine);
    expect(bridge.mediaUpdate).toHaveBeenCalledTimes(1);
    expect(payloads()[0]).toEqual({
      title: "Song A",
      artist: "Artist A",
      artwork: "/api/audio?key=a.jpg",
      playing: true,
      buffering: false,
      position: 10,
      duration: 200,
      hasNext: true,
      hasPrev: false,
    });
  });

  it("dedupes unchanged snapshots and sends on state changes", () => {
    const engine = fakeEngine();
    bindAndroidMedia(engine);
    engine.set({ time: 11 });
    engine.set({ playing: true });
    expect(bridge.mediaUpdate).toHaveBeenCalledTimes(1);

    engine.set({ playing: false });
    expect(bridge.mediaUpdate).toHaveBeenCalledTimes(2);
    expect(payloads()[1].playing).toBe(false);

    engine.set({ index: 1, track: B, artwork: "", artist: "Artist B" });
    expect(bridge.mediaUpdate).toHaveBeenCalledTimes(3);
    const last = payloads()[2];
    expect(last.hasNext).toBe(false);
    expect(last.hasPrev).toBe(true);
    expect(last.artwork).toBe("");
  });

  it("throttles position drift but never drops a seek", () => {
    let clock = 0;
    const engine = fakeEngine();
    bindAndroidMedia(engine, { now: () => clock, throttleMs: 5_000 });
    expect(bridge.mediaUpdate).toHaveBeenCalledTimes(1);

    clock = 1_000;
    engine.set({ time: 12 });
    expect(bridge.mediaUpdate).toHaveBeenCalledTimes(1);

    clock = 5_000;
    engine.set({ time: 20 });
    expect(bridge.mediaUpdate).toHaveBeenCalledTimes(2);
    expect(payloads()[1].position).toBe(20);

    clock = 6_000;
    engine.seek(120);
    expect(bridge.mediaUpdate).toHaveBeenCalledTimes(3);
    expect(payloads()[2].position).toBe(120);
  });

  it("does not mistake normal playback for a jump", () => {
    let clock = 0;
    const engine = fakeEngine();
    bindAndroidMedia(engine, { now: () => clock, throttleMs: 5_000 });

    clock = 3_000;
    engine.set({ time: 13 });
    expect(bridge.mediaUpdate).toHaveBeenCalledTimes(1);

    engine.set({ time: 40 });
    expect(bridge.mediaUpdate).toHaveBeenCalledTimes(2);
  });

  it("maps window events to engine actions", () => {
    const engine = fakeEngine();
    bindAndroidMedia(engine);
    fire({ action: "play" });
    fire({ action: "pause" });
    fire({ action: "next" });
    fire({ action: "prev" });
    fire({ action: "seekto", time: 42.5 });
    fire({ action: "seekto" });
    fire({ action: "unknown" });
    expect(engine.resume).toHaveBeenCalledTimes(1);
    expect(engine.pause).toHaveBeenCalledTimes(1);
    expect(engine.next).toHaveBeenCalledTimes(1);
    expect(engine.prev).toHaveBeenCalledTimes(1);
    expect(engine.seek).toHaveBeenCalledTimes(1);
    expect(engine.seek).toHaveBeenCalledWith(42.5);
  });

  it("clears once when the track disappears, and resumes when it comes back", () => {
    const engine = fakeEngine();
    bindAndroidMedia(engine);
    engine.set({ track: null });
    engine.set({ track: null });
    expect(bridge.mediaClear).toHaveBeenCalledTimes(1);
    expect(bridge.mediaUpdate).toHaveBeenCalledTimes(1);

    engine.set({ track: A });
    expect(bridge.mediaUpdate).toHaveBeenCalledTimes(2);
    engine.set({ track: null });
    expect(bridge.mediaClear).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes and removes its listener on cleanup", () => {
    const engine = fakeEngine();
    const off = bindAndroidMedia(engine);
    off();
    expect(listeners.get("spitifo-media")).toHaveLength(0);
    fire({ action: "next" });
    expect(engine.next).not.toHaveBeenCalled();
    engine.set({ playing: false });
    expect(bridge.mediaUpdate).toHaveBeenCalledTimes(1);
    expect(bridge.mediaClear).toHaveBeenCalledTimes(1);
  });
});
