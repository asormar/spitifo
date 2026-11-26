import { describe, expect, it } from "vitest";
import { resistedDy, scrimOpacity, shouldDismiss, shouldSkip } from "./npGestures.js";

describe("resistedDy", () => {
  it("tracks the finger 1:1 before the 35% threshold", () => {
    expect(resistedDy(0, 1000)).toBe(0);
    expect(resistedDy(200, 1000)).toBe(200);
    expect(resistedDy(350, 1000)).toBe(350);
  });

  it("resists past the threshold: only a third of the extra travel counts", () => {
    /* 1000 * 0.35 = 350 umbral; 150px de mas -> 50px de progreso real. */
    expect(resistedDy(500, 1000)).toBeCloseTo(400, 5);
    expect(resistedDy(1000, 1000)).toBeCloseTo(350 + 650 / 3, 5);
  });
});

describe("scrimOpacity", () => {
  it("is opaque at rest and fades out with progress", () => {
    expect(scrimOpacity(0, 1000)).toBe(1);
    expect(scrimOpacity(350, 1000)).toBeCloseTo(0.5, 5);
  });

  it("reaches zero at SCRIM_RANGE (70%) and stays there", () => {
    expect(scrimOpacity(700, 1000)).toBe(0);
    expect(scrimOpacity(900, 1000)).toBe(0);
  });
});

describe("shouldDismiss", () => {
  const height = 1000;

  it("commits past ~35% of the height even at rest speed", () => {
    /* El umbral real es 0.95 * 35% = 33.25% de la altura (332.5px aqui). */
    expect(shouldDismiss(300, 0, height)).toBe(false);
    expect(shouldDismiss(340, 0, height)).toBe(true);
  });

  it("commits on a fast flick before reaching the distance threshold", () => {
    expect(shouldDismiss(50, 0.6, height)).toBe(true);
    expect(shouldDismiss(50, 0.4, height)).toBe(false);
  });
});

describe("shouldSkip", () => {
  const width = 300;

  it("commits past 35% of the width", () => {
    expect(shouldSkip(100, 0, width)).toBe(false);
    expect(shouldSkip(105, 0, width)).toBe(true);
    expect(shouldSkip(-105, 0, width)).toBe(true);
  });

  it("commits on a release faster than 0.5 px/ms regardless of distance", () => {
    expect(shouldSkip(10, 0.6, width)).toBe(true);
    expect(shouldSkip(10, 0.4, width)).toBe(false);
  });
});
