import { describe, expect, it } from "vitest";
import { sameMap } from "./mapEq.js";

describe("sameMap", () => {
  it("is true for the same reference", () => {
    const m = new Map([["a", 1]]);
    expect(sameMap(m, m)).toBe(true);
  });

  it("is true for two maps with the same keys and values", () => {
    const a = new Map([["a", { id: "a", n: 1 }], ["b", { id: "b", n: 2 }]]);
    const b = new Map([["a", { id: "a", n: 1 }], ["b", { id: "b", n: 2 }]]);
    expect(sameMap(a, b)).toBe(true);
  });

  it("is false with a different size", () => {
    const a = new Map([["a", 1]]);
    const b = new Map([["a", 1], ["b", 2]]);
    expect(sameMap(a, b)).toBe(false);
  });

  it("is false when a key is missing", () => {
    const a = new Map([["a", 1]]);
    const b = new Map([["b", 1]]);
    expect(sameMap(a, b)).toBe(false);
  });

  it("is false when a value changed", () => {
    const a = new Map([["a", { n: 1 }]]);
    const b = new Map([["a", { n: 2 }]]);
    expect(sameMap(a, b)).toBe(false);
  });
});
