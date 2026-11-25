import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CROSSFADE_KEY,
  effectiveCrossfade,
  getCrossfade,
  normalizeCrossfade,
  setCrossfade,
  subscribeCrossfade,
} from "./playbackSettings.js";

const store = (initial = null) => {
  const data = new Map(initial === null ? [] : [[CROSSFADE_KEY, initial]]);
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
};

afterEach(() => vi.unstubAllGlobals());

describe("playbackSettings: crossfade", () => {
  it("defaults to off and reads seconds from localStorage", () => {
    vi.stubGlobal("localStorage", store("5"));
    /* El valor inicial se lee al importar el modulo, con localStorage ausente
       en Node: ahi vale el default. setCrossfade lo cambia y lo guarda. */
    expect(setCrossfade(5)).toBe(5);
    expect(getCrossfade()).toBe(5);
  });

  it("clamps to 2-12 s and turns garbage off", () => {
    expect(normalizeCrossfade("7")).toBe(7);
    expect(normalizeCrossfade(1)).toBe(2);
    expect(normalizeCrossfade(99)).toBe(12);
    expect(normalizeCrossfade("nope")).toBe(0);
    expect(normalizeCrossfade(-3)).toBe(0);
  });

  it("set writes the exact key and notifies subscribers", () => {
    const ls = store();
    vi.stubGlobal("localStorage", ls);
    const seen = [];
    const off = subscribeCrossfade((v) => seen.push(v));
    expect(setCrossfade(4)).toBe(4);
    expect(ls.getItem(CROSSFADE_KEY)).toBe("4");
    expect(seen).toEqual([4]);
    off();
  });

  it("survives a blocked storage", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("bloqueado");
      },
      setItem() {
        throw new Error("bloqueado");
      },
    });
    setCrossfade(0);
    expect(getCrossfade()).toBe(0);
    expect(setCrossfade(3)).toBe(3);
  });

  it("reduced motion disables the transition", () => {
    expect(effectiveCrossfade(6, true)).toBe(0);
    expect(effectiveCrossfade(6, false)).toBe(6);
  });
});
