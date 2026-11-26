import { describe, expect, it } from "vitest";
import { starterGenre, STARTER_GENRE, STARTER_GENRES } from "./starters.js";

describe("starterGenre", () => {
  it("uses the first known genre", () => {
    expect(starterGenre([" Jazz ", "Rock"])).toBe("Jazz");
  });

  it("falls back to a fixed seed while recommendations are cold", () => {
    expect(starterGenre([])).toBe(STARTER_GENRE);
    expect(starterGenre(null)).toBe(STARTER_GENRE);
    expect(STARTER_GENRES).toContain(STARTER_GENRE);
  });
});
