import { describe, expect, it } from "vitest";
import { pushSample, velocity, resistedDy, shouldDismiss, shouldSkip } from "./gestures.js";

describe("reused player maths", () => {
  it("exposes the same resistance and commit rules", () => {
    expect(resistedDy(500, 1000)).toBeCloseTo(400, 5);
    expect(shouldDismiss(340, 0, 1000)).toBe(true);
    expect(shouldSkip(105, 0, 300)).toBe(true);
  });
});

describe("pushSample", () => {
  it("keeps only the five newest samples", () => {
    const samples = [];
    for (let i = 0; i < 7; i++) pushSample(samples, i * 10, i * 16);
    expect(samples).toHaveLength(5);
    expect(samples[0]).toEqual([20, 32]);
    expect(samples[4]).toEqual([60, 96]);
  });
});

describe("velocity", () => {
  it("is zero until there are two samples", () => {
    expect(velocity([])).toBe(0);
    expect(velocity([[0, 0]])).toBe(0);
  });

  it("is px/ms between the oldest and newest sample", () => {
    expect(velocity([[0, 100], [30, 150]])).toBeCloseTo(0.6, 5);
    expect(velocity([[30, 100], [20, 150]])).toBeLessThan(0);
  });

  it("does not divide by zero", () => {
    expect(velocity([[0, 100], [30, 100]])).toBe(0);
  });
});
