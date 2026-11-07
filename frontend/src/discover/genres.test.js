import { describe, expect, it } from "vitest";
import { percent } from "../shared/format.js";
import { FALLBACK_CLUSTER, genreTiles } from "./genres.js";

const raw = {
  n: ["Rock", "Bossa Nová", "jazz", "Electro  Pop", "trip hop"],
  c: [3, 11, 5, 9, 99],
};
const g = (name, share) => ({ name, share });

describe("percent", () => {
  it("redondea a porcentaje entero", () => {
    expect(percent(0.34)).toBe("34 %");
    expect(percent(1)).toBe("100 %");
  });

  it("menos de uno por ciento", () => {
    expect(percent(0.004)).toBe("<1 %");
    expect(percent(0.0049)).toBe("<1 %");
  });
});

describe("genreTiles", () => {
  it("ordena por share, toma el cluster del mapa y da el porcentaje", () => {
    const tiles = genreTiles([g("jazz", 0.2), g("rock", 0.5)], raw);
    expect(tiles).toEqual([
      { name: "rock", share: 0.5, pct: "50 %", c: 3 },
      { name: "jazz", share: 0.2, pct: "20 %", c: 5 },
    ]);
  });

  it("solo los seis primeros", () => {
    const names = Array.from({ length: 9 }, (_, i) => `g${i}`);
    const map = { n: names, c: names.map(() => 1) };
    const genres = names.map((n, i) => g(n, 1 - i / 10));
    const tiles = genreTiles(genres, map);
    expect(tiles).toHaveLength(6);
    expect(tiles[0].name).toBe("g0");
    expect(tiles[5].name).toBe("g5");
  });

  it("salta los generos que el mapa no conoce y no cuenta para los seis", () => {
    const genres = [g("desconocido", 0.9), g("rock", 0.5), g("jazz", 0.2)];
    expect(genreTiles(genres, raw, 2).map((t) => t.name)).toEqual(["rock", "jazz"]);
  });

  it("casa sin acentos, mayusculas ni espacios de mas", () => {
    const tiles = genreTiles([g("bossa nova", 0.3), g("ELECTRO POP", 0.1)], raw);
    expect(tiles.map((t) => t.c)).toEqual([11, 9]);
  });

  it("un cluster fuera de rango se acota a la paleta", () => {
    expect(genreTiles([g("trip hop", 0.1)], raw)[0].c).toBe(15);
  });

  it("<1 % para un genero casi sin peso", () => {
    expect(genreTiles([g("rock", 0.003)], raw)[0].pct).toBe("<1 %");
  });

  it("sin mapa (fallo o aun no llego) usa el color de reserva y no filtra", () => {
    const tiles = genreTiles([g("rock", 0.5), g("desconocido", 0.9)], null);
    expect(tiles.map((t) => t.name)).toEqual(["desconocido", "rock"]);
    expect(tiles.every((t) => t.c === FALLBACK_CLUSTER)).toBe(true);
  });

  it("un mapa con otro formato cuenta como sin mapa", () => {
    expect(genreTiles([g("rock", 0.5)], { n: "no" })[0].c).toBe(FALLBACK_CLUSTER);
  });

  it("sin generos no hay atajos", () => {
    expect(genreTiles([], raw)).toEqual([]);
  });
});
