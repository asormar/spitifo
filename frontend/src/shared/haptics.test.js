import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAPTIC, haptic, haptics } from "./haptics.js";

beforeEach(() => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
  };
  globalThis.SpitifoAndroid = { haptic: vi.fn() };
  haptics.set(true);
});

afterEach(() => {
  delete globalThis.localStorage;
  delete globalThis.SpitifoAndroid;
});

describe("haptics", () => {
  it("forwards discrete confirmations to the Android bridge", () => {
    haptic(HAPTIC.CONFIRM);
    expect(globalThis.SpitifoAndroid.haptic).toHaveBeenCalledWith(HAPTIC.CONFIRM);
  });

  it("stays silent when the switch is off", () => {
    haptics.set(false);
    haptic(HAPTIC.DETENT);
    expect(globalThis.SpitifoAndroid.haptic).not.toHaveBeenCalled();
  });

  it("does nothing without a bridge (desktop or older app)", () => {
    delete globalThis.SpitifoAndroid;
    expect(() => haptic()).not.toThrow();
  });

  it("does not throw when the bridge itself fails", () => {
    globalThis.SpitifoAndroid = {
      haptic: () => {
        throw new Error("bridge");
      },
    };
    expect(() => haptic()).not.toThrow();
  });
});
