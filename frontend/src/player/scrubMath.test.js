import { describe, expect, it } from "vitest";
import { knobOffset, pctFromPointer } from "./scrubMath.js";

describe("pctFromPointer", () => {
  it("reads the fraction of the rail under the pointer", () => {
    expect(pctFromPointer(50, 0, 200)).toBe(0.25);
    expect(pctFromPointer(0, 0, 200)).toBe(0);
    expect(pctFromPointer(200, 0, 200)).toBe(1);
  });

  it("accounts for the rail's own offset", () => {
    expect(pctFromPointer(150, 100, 200)).toBe(0.25);
  });

  it("clamps outside the rail", () => {
    expect(pctFromPointer(-50, 0, 200)).toBe(0);
    expect(pctFromPointer(250, 0, 200)).toBe(1);
  });

  it("never divides by zero on an unmeasured rail", () => {
    expect(pctFromPointer(50, 0, 0)).toBe(0);
  });
});

describe("knobOffset", () => {
  it("centers the knob on the rail position", () => {
    expect(knobOffset(0, 200)).toBe(-7);
    expect(knobOffset(0.5, 200)).toBe(93);
    expect(knobOffset(1, 200)).toBe(193);
  });

  it("uses the given knob size", () => {
    expect(knobOffset(0, 200, 20)).toBe(-10);
  });
});
