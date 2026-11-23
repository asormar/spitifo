import { describe, expect, it } from "vitest";
import { albumPlayable, matchProgress } from "./albumPlay.js";

const track = (over = {}) => ({
  title: "pista",
  artist: "Radiohead",
  extra: { has_full: null },
  ...over,
});

describe("albumPlayable", () => {
  it("acepta una pista emparejada con video completo", () => {
    expect(albumPlayable(track({ extra: { has_full: true, webpage_url: "https://yt/1" } }))).toBe(true);
  });

  it("acepta un avance de 30 s cuando ya se sabia que no habia completa", () => {
    expect(albumPlayable(track({ extra: { has_full: false }, preview_url: "https://prev/1" }))).toBe(true);
  });

  it("no acepta una pista todavia buscando, aunque iTunes traiga avance", () => {
    expect(albumPlayable(track({ preview_url: "https://prev/1" }))).toBe(false);
  });

  it("no acepta nada cuando no hay audio", () => {
    expect(albumPlayable(null)).toBe(false);
    expect(albumPlayable(track({ extra: { has_full: false } }))).toBe(false);
  });
});

describe("matchProgress", () => {
  it("cuenta las pistas listas sobre las del disco", () => {
    const list = [
      track({ extra: { has_full: true, webpage_url: "u1" } }),
      track(),
      track({ extra: { has_full: false }, preview_url: "p3" }),
    ];
    expect(matchProgress(list, 2)).toBe("2 de 3 listas");
    expect(matchProgress(list, 1)).toBe("1 de 3 listas");
  });
});
