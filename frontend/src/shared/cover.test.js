import { describe, expect, it } from "vitest";
import {
  GENRE_COLORS,
  PATTERNS,
  coverTone,
  hash32,
  toneClass,
  toneColor,
  tonePattern,
  toneVars,
} from "./cover.js";

describe("coverTone", () => {
  it("is stable for the same artist and album", () => {
    expect(coverTone("Rosalía", "Motomami")).toBe(coverTone("Rosalía", "Motomami"));
    expect(coverTone("Rosalía")).toBe(coverTone("Rosalía"));
  });

  it("stays inside 16 colours x 4 patterns", () => {
    for (const name of ["", "x", "Radiohead", "Soda Stereo", "Zoé", "Sigur Rós", "你好", "A".repeat(500)]) {
      const t = coverTone(name, `${name} II`);
      expect(Number.isInteger(t)).toBe(true);
      expect(toneColor(t)).toBeGreaterThanOrEqual(0);
      expect(toneColor(t)).toBeLessThan(GENRE_COLORS);
      expect(tonePattern(t)).toBeGreaterThanOrEqual(0);
      expect(tonePattern(t)).toBeLessThan(PATTERNS);
    }
  });

  it("gives every album of an artist the artist's colour", () => {
    const colours = new Set(["Uno", "Dos", "Tres", "Cuatro"].map((a) => toneColor(coverTone("Rosalía", a))));
    expect(colours.size).toBe(1);
    expect([...colours][0]).toBe(hash32("Rosalía") % GENRE_COLORS);
  });

  it("varies the pattern between albums and reaches every colour", () => {
    const patterns = new Set(Array.from({ length: 40 }, (_, i) => tonePattern(coverTone("Artista", `Disco ${i}`))));
    expect(patterns.size).toBe(PATTERNS);
    const colours = new Set(Array.from({ length: 200 }, (_, i) => toneColor(coverTone(`Artista ${i}`))));
    expect(colours.size).toBe(GENRE_COLORS);
  });

  it("copes with missing names", () => {
    expect(coverTone(undefined)).toBe(coverTone(""));
    expect(coverTone(null, null)).toBe(coverTone(""));
  });
});

describe("tone to style", () => {
  it("maps a tone to the genre variable and the pattern class", () => {
    const t = 5 + GENRE_COLORS * 2;
    expect(toneVars(t)).toEqual({ "--c": "var(--genre-5)" });
    expect(toneClass(t)).toBe("cv-p2");
    expect(toneClass(0)).toBe("cv-p0");
  });
});
