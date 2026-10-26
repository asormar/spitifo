import { describe, expect, it, vi } from "vitest";
import { classify, createListenTracker } from "./listens.js";

const track = (key, kind = "library", duration = 200) => ({
  key,
  src: `/audio/${key}`,
  title: key,
  duration,
  kind,
  label: key,
});

/* Motor falso: el tracker solo usa getState/subscribe/onTrackEvent. */
function fakeEngine() {
  let state = {
    track: null,
    queue: [],
    index: -1,
    playing: false,
    time: 0,
    duration: 0,
    repeat: "off",
  };
  const listeners = new Set();
  const trackEvents = new Set();
  const emit = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onTrackEvent(fn) {
      trackEvents.add(fn);
      return () => trackEvents.delete(fn);
    },
    set: emit,
    trackEvent(event) {
      trackEvents.forEach((fn) => fn(event));
    },
  };
}

function setup({ send } = {}) {
  const engine = fakeEngine();
  const recorded = [];
  const batches = [];
  const tracker = createListenTracker(engine, {
    now: () => 1_700_000_000_000,
    record: (event) => recorded.push(event),
    send: async (events) => {
      batches.push(events);
      if (send) return send(events);
    },
    windowRef: null,
    navigatorRef: null,
  });
  return { engine, tracker, recorded, batches };
}

const A = track("A/A - Uno.mp3");
const B = track("B/B - Dos.mp3");

describe("classify", () => {
  const half = 200_000;

  it("is a play at half of a track longer than 30 s", () => {
    expect(classify({ durationMs: half, listenedMs: 100_000, reason: "end" }))
      .toBe("play");
    expect(classify({ durationMs: half, listenedMs: 99_999, reason: "end" }))
      .toBe("partial");
  });

  it("uses 4 minutes for tracks longer than 8 minutes", () => {
    expect(classify({ durationMs: 900_000, listenedMs: 240_000, reason: "end" }))
      .toBe("play");
    expect(classify({ durationMs: 900_000, listenedMs: 239_999, reason: "end" }))
      .toBe("partial");
  });

  it("never considers a track of 30 s or less a play", () => {
    expect(classify({ durationMs: 30_000, listenedMs: 30_000, reason: "end" }))
      .toBe("partial");
    expect(classify({ durationMs: 10_000, listenedMs: 10_000, reason: "end" }))
      .toBe("partial");
  });

  it("turns every ended into a play with repeat one", () => {
    expect(classify({
      durationMs: 10_000,
      listenedMs: 1_000,
      reason: "end",
      repeatOne: true,
    })).toBe("play");
  });

  it("is a skip when the user moves on early", () => {
    for (const reason of ["next", "prev", "change"]) {
      expect(classify({ durationMs: 200_000, listenedMs: 29_999, reason }))
        .toBe("skip");
    }
    expect(classify({ durationMs: 200_000, listenedMs: 30_000, reason: "next" }))
      .toBe("partial");
    expect(classify({ durationMs: 100_000, listenedMs: 40_000, reason: "next" }))
      .toBe("partial");
  });

  it("is partial for close or end without enough time", () => {
    expect(classify({ durationMs: 200_000, listenedMs: 1_000, reason: "close" }))
      .toBe("partial");
    expect(classify({ durationMs: 200_000, listenedMs: 1_000, reason: "end" }))
      .toBe("partial");
  });
});

describe("tracker", () => {
  it("accumulates timeupdate deltas and ignores seeks", async () => {
    const { engine, tracker, recorded, batches } = setup();
    engine.set({ track: A, duration: 200, playing: true, time: 0 });
    engine.set({ time: 0.5 });
    engine.set({ time: 1 });
    engine.set({ time: 21 }); // seek: no cuenta
    engine.set({ time: 21.4 });
    engine.trackEvent({ type: "change", reason: "next" });
    await tracker.flush();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      t: 1_700_000_000,
      k: "A/A - Uno.mp3",
      d: 200_000,
      l: 1_400,
      p: 21_400,
      r: "next",
      o: "skip",
    });
    expect(batches).toEqual([recorded]);
    tracker.stop();
  });

  it("does not count time while paused", () => {
    const { engine, tracker, recorded } = setup();
    engine.set({ track: A, duration: 200, playing: true, time: 0 });
    engine.set({ time: 0.5 });
    engine.set({ playing: false, time: 10 });
    engine.set({ playing: true, time: 10 });
    engine.set({ time: 10.5 });
    engine.trackEvent({ type: "end" });

    expect(recorded[0].l).toBe(1_000);
    tracker.stop();
  });

  it("emits one event per session and closes on a track change", () => {
    const { engine, tracker, recorded } = setup();
    engine.set({ track: A, duration: 200, playing: true, time: 0 });
    engine.set({ time: 1 });
    engine.set({ time: 2 });
    engine.set({ time: 3 });
    engine.trackEvent({
      type: "change",
      reason: "change",
      previous: A,
      track: B,
    });
    engine.set({ track: B, duration: 200, playing: true, time: 0 });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ k: A.key, r: "change", o: "skip" });

    engine.trackEvent({ type: "end" });
    expect(recorded).toHaveLength(2);
    expect(recorded[1]).toMatchObject({ k: B.key, r: "end" });
    tracker.stop();
  });

  it("uses every close reason and repeat one", () => {
    const { engine, tracker, recorded } = setup();
    engine.set({ track: A, duration: 200, playing: true, time: 0 });

    engine.trackEvent({ type: "end", repeatOne: true });
    expect(recorded[0]).toMatchObject({ r: "end", o: "play" });

    // Despues del repeat one el motor vuelve a sonar la misma pista.
    engine.set({ time: 0 });
    engine.trackEvent({ type: "change", reason: "prev" });
    expect(recorded[1].r).toBe("prev");
    tracker.stop();
  });

  it("closes with close when the page hides and flushes", async () => {
    const engine = fakeEngine();
    const recorded = [];
    const hidden = [];
    const windowRef = {
      addEventListener: (name, fn) => hidden.push([name, fn]),
      removeEventListener: () => {},
    };
    const navigatorRef = { sendBeacon: () => true };
    const tracker = createListenTracker(engine, {
      now: () => 1_700_000_000_000,
      record: (event) => recorded.push(event),
      send: vi.fn(),
      windowRef,
      navigatorRef,
    });
    engine.set({ track: A, duration: 200, playing: true, time: 0 });
    engine.set({ time: 0.5 });
    const hide = hidden.find(([name]) => name === "pagehide")[1];
    hide();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ r: "close", l: 500 });
    expect(tracker.getPending()).toBe(0);
    tracker.stop();
  });

  it("keeps a failed batch to retry it later", async () => {
    let fail = true;
    const batches = [];
    const { engine, tracker } = setup({
      send: async (events) => {
        if (fail) {
          fail = false;
          throw new Error("offline");
        }
        batches.push(events);
      },
    });
    engine.set({ track: A, duration: 200, playing: true, time: 0 });
    engine.set({ time: 0.5 });
    engine.trackEvent({ type: "end" });

    await tracker.flush();
    expect(tracker.getPending()).toBe(1);

    await tracker.flush();
    expect(tracker.getPending()).toBe(0);
    expect(batches).toHaveLength(1);
    tracker.stop();
  });

  it("ignores previews and videos", () => {
    const { engine, tracker, recorded } = setup();
    engine.set({
      track: track("preview", "preview", 30),
      duration: 30,
      playing: true,
      time: 0,
    });
    engine.set({ time: 1 });
    engine.trackEvent({ type: "end" });
    expect(recorded).toHaveLength(0);
    tracker.stop();
  });
});
