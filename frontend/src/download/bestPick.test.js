import { describe, expect, it } from "vitest";
import { pickBest } from "./bestPick.js";

const song = (title, artist = "ROSALÍA") => ({ source: "itunes", source_id: title, title, artist });
const artist = (name) => ({ id: 1, name, genre: "Flamenco pop" });
const album = (title) => ({ id: 2, title, artist: "ROSALÍA" });

describe("pickBest", () => {
  it("gana el titulo exacto de una cancion antes que un artista", () => {
    const best = pickBest({
      query: "Despechá",
      results: [song("Despechá"), song("Monaco", "Bad Bunny")],
      artists: [artist("ROSALÍA")],
      albums: [album("Motomami")],
    });
    expect(best).toMatchObject({ kind: "song", title: "Despechá", verdict: "match" });
    expect(best.sub).toBe("ROSALÍA");
  });

  it("dibuja un artista cuando el texto lo nombra, con tildes y mayusculas ignoradas", () => {
    const best = pickBest({ query: "rosalia", results: [song("Despechá")], artists: [artist("ROSALÍA")] });
    expect(best).toMatchObject({ kind: "artist", title: "ROSALÍA" });
    expect(best.sub).toBe("Flamenco pop");
  });

  it("encuentra un album exacto y luego un difuso por prefijo", () => {
    expect(pickBest({ query: "Motomami", albums: [album("Motomami +")] })).toMatchObject({
      kind: "album", title: "Motomami +",
    });
    expect(pickBest({ query: "Despe", results: [song("Despechá")] })).toMatchObject({
      kind: "song", title: "Despechá", verdict: null,
    });
  });

  it("no inventa tarjeta sin texto o sin coincidencia", () => {
    expect(pickBest({ query: "  ", results: [song("Despechá")] })).toBeNull();
    expect(pickBest({ query: "zzzz", results: [song("Despechá")] })).toBeNull();
  });
});
