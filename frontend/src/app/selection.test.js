import { describe, expect, it } from "vitest";
import { rangeKeys } from "./selection.js";

describe("rangeKeys", () => {
  const keys = ["a", "b", "c", "d", "e"];

  it("toma el rango en los dos sentidos", () => {
    expect(rangeKeys(keys, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeKeys(keys, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("una sola fila cuando el extremo es el mismo", () => {
    expect(rangeKeys(keys, "c", "c")).toEqual(["c"]);
  });

  it("no inventa filas si alguna clave no esta", () => {
    expect(rangeKeys(keys, "a", "z")).toEqual([]);
    expect(rangeKeys(keys, undefined, "c")).toEqual([]);
  });
});
