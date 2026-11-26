import { describe, expect, it } from "vitest";
import {
  SUGGEST_MAX, didYouMean, editDistance, mergeSuggestions, normalizeSuggestion, suggestTerm,
} from "./suggestions.js";

describe("suggestTerm", () => {
  it("no consulta con menos de dos letras ni con un enlace de YouTube", () => {
    expect(suggestTerm(" m ")).toBeNull();
    expect(suggestTerm("")).toBeNull();
    expect(suggestTerm("https://youtu.be/abcdefghijk")).toBeNull();
  });

  it("recorta el texto antes de pedir", () => {
    expect(suggestTerm("  mes  ")).toBe("mes");
  });
});

describe("editDistance", () => {
  it("mide la distancia sin importar tildes ni mayusculas", () => {
    expect(editDistance("Mesmerizer", "mesmerizer")).toBe(0);
    expect(editDistance("Mesmerzer", "Mesmerizer")).toBe(1);
    expect(editDistance("Rosalia", "ROSALÍA")).toBe(0);
  });
});

describe("didYouMean", () => {
  const names = ["Mesmerizer", "Mesmerize", "Monaco", "Motomami"];

  it("devuelve hasta tres correcciones, las mas cercanas primero", () => {
    expect(didYouMean("Mesmerzer", names)).toEqual(["Mesmerizer", "Mesmerize"]);
    expect(didYouMean("Monesco", names, 3)).toContain("Monaco");
    expect(didYouMean("Mesmerzer", names, 1)).toEqual(["Mesmerizer"]);
  });

  it("descarta la propia consulta y respeta el tope de distancia", () => {
    expect(didYouMean("Mesmerizer", names)).not.toContain("Mesmerizer");
    expect(didYouMean("zzzzzz", names)).toEqual([]);
  });
});

describe("mergeSuggestions", () => {
  it("pone la biblioteca primero y no repite claves", () => {
    const lib = [{ kind: "song", id: "1", title: " Dream ", sub: "Fleetwood Mac", source: "library" }];
    const remote = [
      { kind: "song", id: "1", title: "Dream", sub: "Fleetwood Mac" },
      { kind: "artist", id: "2", title: "ROSALÍA", sub: "Artista" },
      { kind: "album", id: "3", title: "Motomami", sub: "ROSALÍA" },
    ];
    const out = mergeSuggestions(lib, remote);
    expect(out.map((s) => s.title)).toEqual(["Dream", "ROSALÍA", "Motomami"]);
    expect(out[0].source).toBe("library");
    expect(out[0].title).toBe("Dream");
    expect(out[1].kind).toBe("artist");
  });

  it("corta en seis filas y descarta entradas sin titulo", () => {
    const remote = Array.from({ length: 9 }, (_, i) => ({ kind: "song", id: String(i), title: `Cancion ${i}` }));
    expect(mergeSuggestions([null, {}, { title: "  " }], remote)).toHaveLength(SUGGEST_MAX);
  });

  it("normaliza el tipo por defecto a cancion", () => {
    expect(normalizeSuggestion({ title: "Pista", sub: "Artista" })).toMatchObject({
      kind: "song", source: "library", title: "Pista", sub: "Artista",
    });
  });
});
