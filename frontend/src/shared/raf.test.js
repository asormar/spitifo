import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rafThrottle } from "./raf.js";

describe("rafThrottle", () => {
  let frames;

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id) => {
      frames[id - 1] = null;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const flush = () => {
    const pending = frames.splice(0);
    pending.forEach((cb) => cb?.());
  };

  it("coalesces several calls in the same frame into one run", () => {
    const fn = vi.fn();
    const throttled = rafThrottle(fn);
    throttled();
    throttled();
    throttled();
    expect(fn).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs again on the next frame after flushing", () => {
    const fn = vi.fn();
    const throttled = rafThrottle(fn);
    throttled();
    flush();
    throttled();
    flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel drops a pending frame", () => {
    const fn = vi.fn();
    const throttled = rafThrottle(fn);
    throttled();
    throttled.cancel();
    flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel without a pending frame is a no-op", () => {
    const fn = vi.fn();
    const throttled = rafThrottle(fn);
    expect(() => throttled.cancel()).not.toThrow();
  });
});
