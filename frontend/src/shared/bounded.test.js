import { describe, expect, it } from "vitest";
import { addBoundedSet, setBoundedMap } from "./bounded.js";

describe("addBoundedSet", () => {
  it("no saca nada mientras no se pase del tope", () => {
    const set = new Set();
    addBoundedSet(set, "a", 2);
    addBoundedSet(set, "b", 2);
    expect([...set]).toEqual(["a", "b"]);
  });

  it("saca la mas vieja (FIFO) al pasarse del tope", () => {
    const set = new Set();
    addBoundedSet(set, "a", 2);
    addBoundedSet(set, "b", 2);
    addBoundedSet(set, "c", 2);
    expect([...set]).toEqual(["b", "c"]);
    expect(set.size).toBe(2);
  });

  it("volver a anadir una clave que ya estaba no la duplica ni crece el tope", () => {
    const set = new Set();
    addBoundedSet(set, "a", 2);
    addBoundedSet(set, "b", 2);
    addBoundedSet(set, "a", 2);
    expect(set.size).toBe(2);
  });
});

describe("setBoundedMap", () => {
  it("no saca nada mientras no se pase del tope", () => {
    const map = new Map();
    setBoundedMap(map, "a", 1, 2);
    setBoundedMap(map, "b", 2, 2);
    expect([...map.keys()]).toEqual(["a", "b"]);
  });

  it("saca la mas vieja (FIFO) al pasarse del tope", () => {
    const map = new Map();
    setBoundedMap(map, "a", 1, 2);
    setBoundedMap(map, "b", 2, 2);
    setBoundedMap(map, "c", 3, 2);
    expect([...map.keys()]).toEqual(["b", "c"]);
    expect(map.size).toBe(2);
  });

  it("actualizar una clave existente no la hace crecer de mas", () => {
    const map = new Map();
    setBoundedMap(map, "a", 1, 2);
    setBoundedMap(map, "b", 2, 2);
    setBoundedMap(map, "a", 99, 2);
    expect(map.size).toBe(2);
    expect(map.get("a")).toBe(99);
  });
});
