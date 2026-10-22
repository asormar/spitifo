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
const PREVIEW = track("preview", "preview");

function setup() {
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

  it("falls back to a single-track queue when the track is not in it", () => {
    const { engine } = setup();
    engine.play(C, { queue: [A, B] });
    expect(engine.getState().queue).toEqual([C]);
    expect(engine.getState().index).toBe(0);
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
