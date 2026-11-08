import { describe, expect, it } from "vitest";
import { MIXES, mixEntries as entriesOf, mixName, mixSub } from "./mixes.js";
import { normalizeLibrary } from "./library.js";

const file = (key, extra = {}) => ({
  key,
  filename: `${key}.mp3`,
  artist: "Artista",
  title: key,
  kind: "audio",
  duration_s: 200,
  modified: 100,
  ...extra,
});

/* Las mezclas se calculan con la biblioteca y su mapa por clave, como en la app. */
const RECENT_MIX = 30;
const TOP_MIX = 100;
const mixEntries = (key, lib, hist) => entriesOf(key, lib, hist, new Map(lib.map((e) => [e.key, e])));
const keys = (list) => list.map((e) => e.key);
const rec = (plays, last = 0, skips = 0) => ({ plays, skips, last });

describe("MIXES", () => {
  it("lists the four mixes in order, and unknown keys name the first", () => {
    expect(MIXES.map((m) => m[0])).toEqual(["all", "top", "recent", "new"]);
    expect(mixName("recent")).toBe("Añadido hace poco");
    expect(mixName("nope")).toBe("Toda tu biblioteca");
  });
});

describe("mixEntries", () => {
  const LIB = normalizeLibrary([
    file("a", { modified: 10 }),
    file("b", { modified: 40 }),
    file("c", { modified: 30 }),
    file("v", { kind: "video", modified: 99 }),
    file("d", { modified: 20 }),
  ]);
  const hist = {
    tracks: { a: rec(2, 5), b: rec(5, 1), c: rec(2, 9), v: rec(9, 1), gone: rec(7, 1), d: rec(0, 2, 3) },
  };

  it("all is every playable entry and drops videos", () => {
    expect(keys(mixEntries("all", LIB, hist))).toEqual(["a", "b", "c", "d"]);
  });

  it("an unknown key falls back to all", () => {
    expect(keys(mixEntries("zzz", LIB, hist))).toEqual(["a", "b", "c", "d"]);
  });

  it("top keeps played tracks by plays then last, skipping videos and deleted files", () => {
    expect(keys(mixEntries("top", LIB, hist))).toEqual(["b", "c", "a"]);
  });

  it("top has nothing without history", () => {
    expect(mixEntries("top", LIB, undefined)).toEqual([]);
    expect(mixEntries("top", LIB, { tracks: {} })).toEqual([]);
  });

  it("top is capped", () => {
    const many = normalizeLibrary(Array.from({ length: TOP_MIX + 20 }, (_, i) => file(`t${i}`)));
    const tracks = Object.fromEntries(many.map((e, i) => [e.key, rec(1, i)]));
    expect(mixEntries("top", many, { tracks })).toHaveLength(TOP_MIX);
  });

  it("recent is the newest ones, capped and without videos", () => {
    expect(keys(mixEntries("recent", LIB, hist))).toEqual(["b", "c", "d", "a"]);
    const many = normalizeLibrary(
      Array.from({ length: RECENT_MIX + 5 }, (_, i) => file(`t${i}`, { modified: i + 1 }))
    );
    const out = mixEntries("recent", many, hist);
    expect(out).toHaveLength(RECENT_MIX);
    expect(out[0].key).toBe(`t${RECENT_MIX + 4}`);
  });

  it("recent keeps the library order on ties", () => {
    const tie = normalizeLibrary([file("x"), file("y"), file("z")]);
    expect(keys(mixEntries("recent", tie, {}))).toEqual(["x", "y", "z"]);
  });

  it("new is what was never played; a skipped track counts as heard", () => {
    const lib = normalizeLibrary([file("a"), file("b"), file("c"), file("s")]);
    const h = { tracks: { a: rec(1), b: rec(0), s: rec(0, 1, 2) } };
    expect(keys(mixEntries("new", lib, h))).toEqual(["b", "c"]);
  });

  it("without history, new equals all", () => {
    expect(keys(mixEntries("new", LIB, undefined))).toEqual(keys(mixEntries("all", LIB, undefined)));
  });
});

describe("mixSub", () => {
  it("counts songs, singular included", () => {
    expect(mixSub("all", 12)).toBe("12 canciones en orden aleatorio, sin fin");
    expect(mixSub("all", 1)).toBe("1 canción en orden aleatorio, sin fin");
  });

  it("says why an empty mix is empty", () => {
    expect(mixSub("top", 0)).toBe("Aún no hay canciones escuchadas.");
    expect(mixSub("new", 0)).toBe("Ya has escuchado toda tu biblioteca.");
    expect(mixSub("recent", 0)).toBe("Todavía no hay canciones.");
  });
});
