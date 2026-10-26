import { describe, expect, it, vi } from "vitest";
import { createEngine } from "./engine.js";

/* <audio> falso: solo lo que el motor usa (EventTarget + campos y metodos del
   HTMLMediaElement). `play()` dispara play y playing de forma sincrona, como
   hace el navegador cuando el archivo ya esta en cache. */
class FakeAudio extends EventTarget {
  constructor() {
    super();
    this.paused = true;
    this.currentTime = 0;
    this.duration = NaN;
    this.volume = 1;
    this.muted = false;
    this.srcSets = 0;
    this._src = "";
  }

  get src() {
    return this._src;
  }

  set src(value) {
    this._src = value;
    this.srcSets += 1;
  }

  play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
}

const track = (key, kind = "library") => ({
  key,
  src: `/audio/${key}`,
  title: `Title ${key}`,
  meta: `Meta ${key}`,
  duration: 180,
  artwork: null,
  kind,
  label: `Title ${key}`,
});

const A = track("a");
const B = track("b");
const C = track("c");
const D = track("d");
const PREVIEW = track("preview", "preview");

function setup({ random } = {}) {
  const audios = [];
  const fetches = [];
  let started = 0;
  const engine = createEngine({
    createAudio: () => {
      const a = new FakeAudio();
      audios.push(a);
      return a;
    },
    fetchFn: (url, init) => {
      fetches.push({ url, init });
      return Promise.resolve();
    },
    onPlayStart: () => {
      started += 1;
    },
    ...(random ? { random } : {}),
  });
  return { engine, audios, fetches, audio: () => audios[0], started: () => started };
}

describe("ciclo de vida del elemento", () => {
  it("does not create an Audio at import time", async () => {
    /* El singleton usa `new Audio()` por defecto: si el modulo lo construyera
       al importar, este archivo ni siquiera cargaria en Node. El stub lo hace
       explicito: importar no puede instanciar nada. */
    let created = 0;
    vi.stubGlobal(
      "Audio",
      class {
        constructor() {
          created += 1;
        }
      }
    );
    vi.resetModules();
    const mod = await import("./engine.js");
    expect(created).toBe(0);
    expect(mod.engine.getState().track).toBeNull();
    vi.unstubAllGlobals();
  });

  it("creates the element lazily on the first play", () => {
    const { engine, audios } = setup();
    expect(audios).toHaveLength(0);
    engine.play(A);
    expect(audios).toHaveLength(1);
  });
});

describe("play", () => {
  it("sets track, queue, index and src", () => {
    const { engine, audio } = setup();
    engine.play(B, { queue: [A, B, C], index: 1 });
    const s = engine.getState();
    expect(s.track).toBe(B);
    expect(s.queue).toEqual([A, B, C]);
    expect(s.index).toBe(1);
    expect(s.time).toBe(0);
    expect(s.failed).toBe(false);
    expect(audio().src).toBe(B.src);
    expect(audio().volume).toBeCloseTo(0.8);
  });

  it("goes to playing through the events", () => {
    const { engine } = setup();
    engine.play(A);
    expect(engine.getState().playing).toBe(true);
    expect(engine.getState().buffering).toBe(false);
  });

  it("resumes the same track without reloading the src", () => {
    const { engine, audio } = setup();
    engine.play(A);
    const sets = audio().srcSets;
    engine.pause();
    expect(engine.getState().playing).toBe(false);
    engine.play(A);
    expect(audio().srcSets).toBe(sets);
    expect(engine.getState().playing).toBe(true);
  });

  it("restart reloads the same track from 0 with the new queue", () => {
    const { engine, audio } = setup();
    engine.play(A, { queue: [A, B] });
    engine.seek(30);
    const sets = audio().srcSets;
    engine.play(A, { queue: [A, C, D], index: 0, restart: true });
    const s = engine.getState();
    expect(audio().srcSets).toBe(sets + 1);
    expect(s.queue).toEqual([A, C, D]);
    expect(s.index).toBe(0);
    expect(s.time).toBe(0);
  });

  it("restart with shuffle on puts the requested track first", () => {
    const { engine } = setup({ random: () => 0 });
    engine.setShuffle(true);
    engine.play(C, { queue: [A, B, C] });
    engine.play(C, { queue: [A, B, C, D], index: 2, restart: true });
    const s = engine.getState();
    expect(s.queue[0]).toBe(C);
    expect(s.index).toBe(0);
    expect(s.queue).toHaveLength(4);
  });

  it("falls back to a single-track queue when the track is not in it", () => {
    const { engine } = setup();
    engine.play(C, { queue: [A, B] });
    expect(engine.getState().queue).toEqual([C]);
    expect(engine.getState().index).toBe(0);
  });

  it("resumes from `at` seconds after setting the src", () => {
    const { engine, audio } = setup();
    engine.play(B, { queue: [A, B, C], index: 1, at: 42 });
    expect(audio().src).toBe(B.src);
    expect(audio().currentTime).toBe(42);
    expect(engine.getState().time).toBe(42);
    expect(engine.getState().index).toBe(1);
  });

  it("ignores an `at` that is not inside the track", () => {
    const { engine, audio } = setup();
    engine.play(A, { at: 179.5 });
    expect(audio().currentTime).toBe(0);
    expect(engine.getState().time).toBe(0);
    engine.play(B, { at: -5 });
    expect(audio().currentTime).toBe(0);
    engine.play(C, { at: "nope" });
    expect(audio().currentTime).toBe(0);
  });

  it("starts from 0 when no `at` is given", () => {
    const { engine } = setup();
    engine.play(A, { at: 30 });
    expect(engine.getState().time).toBe(30);
    engine.play(B);
    expect(engine.getState().time).toBe(0);
  });
});

describe("ended", () => {
  it("advances to the next track", () => {
    const { engine, audio } = setup();
    engine.play(A, { queue: [A, B, C] });
    audio().currentTime = 179;
    audio().dispatchEvent(new Event("ended"));
    const s = engine.getState();
    expect(s.track).toBe(B);
    expect(s.index).toBe(1);
    expect(s.time).toBe(0);
    expect(audio().src).toBe(B.src);
  });

  it("stops and rewinds on the last track", () => {
    const { engine, audio } = setup();
    engine.play(B, { queue: [A, B], index: 1 });
    audio().currentTime = 179;
    audio().dispatchEvent(new Event("ended"));
    const s = engine.getState();
    expect(s.track).toBe(B);
    expect(s.playing).toBe(false);
    expect(s.time).toBe(0);
    expect(audio().currentTime).toBe(0);
  });
});

describe("next / prev", () => {
  it("next advances and stops at the end", () => {
    const { engine } = setup();
    engine.play(A, { queue: [A, B, C] });
    expect(engine.next()).toBe(true);
    expect(engine.getState().track).toBe(B);
    expect(engine.next()).toBe(true);
    expect(engine.getState().track).toBe(C);
    expect(engine.next()).toBe(false);
    expect(engine.getState().track).toBe(C);
  });

  it("prev restarts the current track after three seconds", () => {
    const { engine, audio } = setup();
    engine.play(B, { queue: [A, B] });
    audio().currentTime = 5;
    audio().dispatchEvent(new Event("timeupdate"));
    engine.prev();
    expect(engine.getState().track).toBe(B);
    expect(engine.getState().time).toBe(0);
    expect(audio().currentTime).toBe(0);
  });

  it("prev goes back before three seconds", () => {
    const { engine, audio } = setup();
    engine.play(B, { queue: [A, B] });
    audio().currentTime = 2;
    audio().dispatchEvent(new Event("timeupdate"));
    engine.prev();
    expect(engine.getState().track).toBe(A);
    expect(engine.getState().index).toBe(0);
  });
});

describe("seek", () => {
  it("clamps to the duration and updates the time immediately", () => {
    const { engine, audio } = setup();
    engine.play(A);
    engine.seek(999);
    expect(audio().currentTime).toBe(180);
    expect(engine.getState().time).toBe(180);
    engine.seek(-4);
    expect(engine.getState().time).toBe(0);
  });
});

describe("prefetch", () => {
  it("posts the next library key once", () => {
    const { engine, fetches } = setup();
    engine.play(A, { queue: [A, B, C] });
    expect(fetches).toHaveLength(1);
    expect(fetches[0].url).toBe("/api/prefetch");
    expect(fetches[0].init.method).toBe("POST");
    expect(JSON.parse(fetches[0].init.body)).toEqual({ key: B.key });
  });

  it("does not repeat the same key when resuming", () => {
    const { engine, fetches } = setup();
    engine.play(A, { queue: [A, B] });
    engine.pause();
    engine.resume();
    expect(fetches).toHaveLength(1);
  });

  it("never prefetches previews", () => {
    const { engine, fetches } = setup();
    engine.play(A, { queue: [A, PREVIEW] });
    expect(fetches).toHaveLength(0);
  });

  it("never prefetches when there is no next track", () => {
    const { engine, fetches } = setup();
    engine.play(B, { queue: [A, B], index: 1 });
    expect(fetches).toHaveLength(0);
  });
});

describe("volume", () => {
  it("applies volume and silence to the element", () => {
    const { engine, audio } = setup();
    engine.setVolume(0.35);
    expect(engine.getState().volume).toBeCloseTo(0.35);
    expect(engine.getState().muted).toBe(false);
    expect(audio().volume).toBeCloseTo(0.35);

    engine.setVolume(0);
    expect(engine.getState().muted).toBe(true);
    expect(audio().muted).toBe(true);
  });

  it("unmuting from 0 restores 0.8", () => {
    const { engine } = setup();
    engine.setVolume(0);
    engine.toggleMute();
    expect(engine.getState().volume).toBeCloseTo(0.8);
    expect(engine.getState().muted).toBe(false);
    engine.toggleMute();
    expect(engine.getState().muted).toBe(true);
    expect(engine.getState().volume).toBeCloseTo(0.8);
  });
});

describe("onPlayStart", () => {
  it("runs on play and on resume", () => {
    const { engine, started } = setup();
    engine.play(A);
    expect(started()).toBe(1);
    engine.pause();
    engine.resume();
    expect(started()).toBe(2);
  });
});

describe("subscribe", () => {
  it("notifies only when something changed, and stops on unsubscribe", () => {
    const { engine } = setup();
    let n = 0;
    const off = engine.subscribe(() => {
      n += 1;
    });
    engine.setVolume(0.5);
    expect(n).toBe(1);
    /* Misma foto: no se emite. */
    engine.setVolume(0.5);
    expect(n).toBe(1);
    engine.setVolume(0.6);
    expect(n).toBe(2);
    off();
    engine.setVolume(0.7);
    expect(n).toBe(2);
  });
});

describe("queue edits", () => {
  it("playNext inserts after the current track and removes a later duplicate", () => {
    const { engine } = setup();
    engine.play(A, { queue: [A, B, C] });
    expect(engine.playNext(A)).toBe(false);
    expect(engine.playNext(C)).toBe(true);
    expect(engine.getState().queue.map((t) => t.key)).toEqual(["a", "c", "b"]);
    expect(engine.getState().index).toBe(0);
  });

  it("playNext and enqueue start playback when nothing is loaded", () => {
    const first = setup();
    expect(first.engine.playNext(A)).toBe(true);
    expect(first.engine.getState().track).toBe(A);
    expect(first.audio().src).toBe(A.src);

    const second = setup();
    expect(second.engine.enqueue(B)).toBe(true);
    expect(second.engine.getState().track).toBe(B);
    expect(second.audio().src).toBe(B.src);
  });

  it("enqueue appends and refuses the current or an upcoming track", () => {
    const { engine } = setup();
    engine.play(A, { queue: [A, B] });
    expect(engine.enqueue(B)).toBe(false);
    expect(engine.enqueue(A)).toBe(false);
    expect(engine.enqueue(C)).toBe(true);
    expect(engine.getState().queue.map((t) => t.key)).toEqual(["a", "b", "c"]);
    expect(engine.enqueue(C)).toBe(false);
  });

  it("move reorders only the upcoming part", () => {
    const { engine } = setup();
    engine.play(A, { queue: [A, B, C] });
    expect(engine.move(1, 2)).toBe(true);
    expect(engine.getState().queue.map((t) => t.key)).toEqual(["a", "c", "b"]);
    /* Ni la actual ni una posicion fuera de la cola se pueden mover. */
    expect(engine.move(0, 2)).toBe(false);
    expect(engine.move(1, 0)).toBe(false);
    expect(engine.move(1, 3)).toBe(false);
    expect(engine.getState().queue.map((t) => t.key)).toEqual(["a", "c", "b"]);
  });

  it("removeAt before the current track keeps it and fixes the index", () => {
    const { engine } = setup();
    engine.play(C, { queue: [A, B, C] });
    expect(engine.removeAt(1)).toBe(true);
    expect(engine.getState().track).toBe(C);
    expect(engine.getState().index).toBe(1);
    expect(engine.getState().queue.map((t) => t.key)).toEqual(["a", "c"]);
    expect(engine.removeAt(1)).toBe(false);
    expect(engine.removeAt(9)).toBe(false);
  });
});

describe("shuffle", () => {
  it("keeps the current track first and every other track once", () => {
    const { engine } = setup({ random: () => 0 });
    engine.play(B, { queue: [A, B, C, D] });
    expect(engine.setShuffle(true)).toBe(true);
    const s = engine.getState();
    expect(s.shuffle).toBe(true);
    expect(s.index).toBe(0);
    expect(s.queue[0]).toBe(B);
    expect(s.queue).toHaveLength(4);
    expect(new Set(s.queue.map((t) => t.key))).toEqual(
      new Set(["a", "b", "c", "d"])
    );
    expect(engine.setShuffle(true)).toBe(false);
  });

  it("restores the user order, including tracks enqueued while shuffled", () => {
    const { engine } = setup({ random: () => 0.5 });
    engine.play(A, { queue: [A, B, C] });
    engine.setShuffle(true);
    engine.enqueue(D);
    expect(engine.getState().queue).toHaveLength(4);
    expect(engine.setShuffle(false)).toBe(true);
    const s = engine.getState();
    expect(s.shuffle).toBe(false);
    expect(s.queue.map((t) => t.key)).toEqual(["a", "b", "c", "d"]);
    expect(s.index).toBe(0);
  });

  it("restores the index of the current track when unshuffling", () => {
    const { engine } = setup({ random: () => 0 });
    engine.play(B, { queue: [A, B, C] });
    engine.setShuffle(true);
    expect(engine.getState().index).toBe(0);
    engine.setShuffle(false);
    expect(engine.getState().queue.map((t) => t.key)).toEqual(["a", "b", "c"]);
    expect(engine.getState().index).toBe(1);
  });

  it("playAt jumps inside the shuffled queue without reshuffling it", () => {
    const { engine, audio } = setup({ random: () => 0 });
    engine.play(A, { queue: [A, B, C, D] });
    engine.setShuffle(true);
    const before = engine.getState().queue;
    expect(engine.playAt(2)).toBe(true);
    const s = engine.getState();
    expect(s.queue).toBe(before);
    expect(s.index).toBe(2);
    expect(s.track).toBe(before[2]);
    expect(audio().src).toBe(before[2].src);
    expect(engine.playAt(9)).toBe(false);
    engine.setShuffle(false);
    expect(engine.getState().queue.map((t) => t.key)).toEqual(["a", "b", "c", "d"]);
  });

  it("plays a new queue shuffled with the requested track first", () => {
    const { engine } = setup({ random: () => 0 });
    engine.setShuffle(true);
    engine.play(C, { queue: [A, B, C, D] });
    const s = engine.getState();
    expect(s.queue[0]).toBe(C);
    expect(s.index).toBe(0);
    expect(new Set(s.queue.map((t) => t.key))).toEqual(
      new Set(["a", "b", "c", "d"])
    );
  });
});

describe("repeat", () => {
  it("replays the current track on ended without reloading the src", () => {
    const { engine, audio } = setup();
    engine.play(A, { queue: [A, B] });
    expect(engine.setRepeat("one")).toBe(true);
    const sets = audio().srcSets;
    audio().currentTime = 179;
    audio().dispatchEvent(new Event("ended"));
    const s = engine.getState();
    expect(s.track).toBe(A);
    expect(s.playing).toBe(true);
    expect(audio().currentTime).toBe(0);
    expect(audio().srcSets).toBe(sets);
  });

  it("wraps to the first track on ended with repeat all", () => {
    const { engine, audio } = setup();
    engine.play(C, { queue: [A, B, C], index: 2 });
    engine.setRepeat("all");
    audio().dispatchEvent(new Event("ended"));
    expect(engine.getState().track).toBe(A);
    expect(engine.getState().index).toBe(0);
    expect(audio().src).toBe(A.src);
  });

  it("wraps a one-track queue on ended with repeat all", () => {
    const { engine, audio } = setup();
    engine.play(A);
    engine.setRepeat("all");
    const sets = audio().srcSets;
    audio().dispatchEvent(new Event("ended"));
    expect(engine.getState().track).toBe(A);
    expect(audio().srcSets).toBe(sets + 1);
  });

  it("wraps on a manual next with repeat all", () => {
    const { engine } = setup();
    engine.play(B, { queue: [A, B], index: 1 });
    engine.setRepeat("all");
    expect(engine.next()).toBe(true);
    expect(engine.getState().track).toBe(A);
    expect(engine.getState().index).toBe(0);
  });

  it("manual next still advances with repeat one", () => {
    const { engine } = setup();
    engine.play(A, { queue: [A, B] });
    engine.setRepeat("one");
    expect(engine.next()).toBe(true);
    expect(engine.getState().track).toBe(B);
  });

  it("stops at the end with repeat off", () => {
    const { engine, audio } = setup();
    engine.play(B, { queue: [A, B], index: 1 });
    engine.setRepeat("all");
    engine.setRepeat("off");
    audio().dispatchEvent(new Event("ended"));
    expect(engine.getState().track).toBe(B);
    expect(engine.getState().playing).toBe(false);
  });

  it("cycles off, all, one and rejects unknown modes", () => {
    const { engine } = setup();
    expect(engine.getState().repeat).toBe("off");
    expect(engine.cycleRepeat()).toBe(true);
    expect(engine.getState().repeat).toBe("all");
    expect(engine.cycleRepeat()).toBe(true);
    expect(engine.getState().repeat).toBe("one");
    expect(engine.cycleRepeat()).toBe(true);
    expect(engine.getState().repeat).toBe("off");
    expect(engine.setRepeat("sometimes")).toBe(false);
    expect(engine.getState().repeat).toBe("off");
  });
});

describe("row registration", () => {
  it("keeps one box per screen for the same song and releases only its own", () => {
    const { engine } = setup();
    const listen = {};
    const download = {};
    const offListen = engine.registerElement("k", listen);
    const offDownload = engine.registerElement("k", download);
    expect(engine.elementsFor("k")).toEqual([listen, download]);
    offDownload();
    expect(engine.elementsFor("k")).toEqual([listen]);
    offListen();
    expect(engine.elementsFor("k")).toEqual([]);
  });

  it("keeps the same array between changes so observers are not recreated", () => {
    const { engine } = setup();
    const off = engine.registerElement("k", {});
    expect(engine.elementsFor("k")).toBe(engine.elementsFor("k"));
    off();
  });
});
