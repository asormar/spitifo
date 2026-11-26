import { afterEach, describe, expect, it, vi } from "vitest";
import { motion, motionAfter, reducedMotion } from "./motion.js";

const setReduced = (on) => {
  globalThis.matchMedia = vi.fn(() => ({ matches: on }));
};

afterEach(() => {
  delete globalThis.matchMedia;
  vi.useRealTimers();
});

describe("motion", () => {
  it("returns the requested duration when motion is allowed", () => {
    setReduced(false);
    expect(reducedMotion()).toBe(false);
    expect(motion(280)).toBe(280);
  });

  it("returns zero under reduced motion", () => {
    setReduced(true);
    expect(reducedMotion()).toBe(true);
    expect(motion(280)).toBe(0);
  });

  it("works when matchMedia is unavailable (Node, old WebViews)", () => {
    expect(reducedMotion()).toBe(false);
    expect(motion(180)).toBe(180);
  });
});

describe("motionAfter", () => {
  it("calls back in the same tick when motion is reduced", () => {
    setReduced(true);
    vi.useFakeTimers();
    const fn = vi.fn();
    motionAfter(fn, 500);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("waits the duration and can be cancelled when motion is allowed", () => {
    setReduced(false);
    vi.useFakeTimers();
    const fn = vi.fn();
    const cancel = motionAfter(fn, 180);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(179);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    const other = vi.fn();
    const cancelOther = motionAfter(other, 180);
    cancelOther();
    vi.runAllTimers();
    expect(other).not.toHaveBeenCalled();
    expect(typeof cancel).toBe("function");
  });
});
