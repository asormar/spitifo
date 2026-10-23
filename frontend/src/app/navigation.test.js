import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODES,
  canStartSwipe,
  modeDirection,
  nextGuess,
  readPhoneNav,
  readView,
  swipeTarget,
  writePhoneNav,
  writeView,
} from "./navigation.js";

const params = (search) => new URLSearchParams(search);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readView", () => {
  it("defaults to download without a view", () => {
    expect(readView("")).toEqual({ mode: "download", settings: false });
    expect(readView("?mode=ytdlp&q=hola")).toEqual({ mode: "download", settings: false });
  });

  it("reads every mode", () => {
    MODES.forEach((mode) => {
      const search = mode === "download" ? "" : `?view=${mode}`;
      expect(readView(search)).toEqual({ mode, settings: false });
    });
  });

  it("treats settings as a screen over download", () => {
    expect(readView("?view=settings&mode=ytdlp&q=x")).toEqual({
      mode: "download",
      settings: true,
    });
  });

  it("ignores an unknown view", () => {
    expect(readView("?view=radio")).toEqual({ mode: "download", settings: false });
  });
});

describe("writeView", () => {
  it("removes view when going back to download", () => {
    expect(writeView("?view=listen", { mode: "download", settings: false })).toBe("");
  });

  it("keeps mode and q when the view changes", () => {
    const out = writeView("?mode=ytdlp&q=hola", { mode: "listen", settings: false });
    expect(params(out).get("view")).toBe("listen");
    expect(params(out).get("mode")).toBe("ytdlp");
    expect(params(out).get("q")).toBe("hola");
  });

  it("keeps mode and q when returning to download", () => {
    const out = writeView("?view=discover&mode=ytdlp&q=hola", { mode: "download" });
    expect(params(out).get("view")).toBeNull();
    expect(params(out).get("mode")).toBe("ytdlp");
    expect(params(out).get("q")).toBe("hola");
  });

  it("writes settings without dropping the rest", () => {
    const out = writeView("?view=listen&mode=ytdlp&q=hola", {
      mode: "download",
      settings: true,
    });
    expect(params(out).get("view")).toBe("settings");
    expect(params(out).get("mode")).toBe("ytdlp");
    expect(params(out).get("q")).toBe("hola");
  });

  it("round-trips with readView", () => {
    const out = writeView("?mode=ytdlp&q=x", { mode: "discover", settings: false });
    expect(readView(out)).toEqual({ mode: "discover", settings: false });
  });
});

describe("nextGuess", () => {
  it("preloads the most likely neighbour", () => {
    expect(nextGuess("download")).toBe("listen");
    expect(nextGuess("listen")).toBe("discover");
    expect(nextGuess("discover")).toBe("listen");
  });
});

describe("modeDirection", () => {
  it("follows the MODES order", () => {
    expect(modeDirection("download", "listen")).toBe(1);
    expect(modeDirection("listen", "discover")).toBe(1);
    expect(modeDirection("listen", "download")).toBe(-1);
    expect(modeDirection("discover", "download")).toBe(-1);
  });

  it("stays still on the same mode", () => {
    expect(modeDirection("download", "download")).toBe(0);
  });

  it("returns 0 when either side is not a mode", () => {
    expect(modeDirection("settings", "listen")).toBe(0);
    expect(modeDirection("listen", "settings")).toBe(0);
    expect(modeDirection(undefined, "discover")).toBe(0);
  });
});

describe("swipeTarget", () => {
  const swipe = (dx, dy, dt) => ({ dx, dy, dt });

  it("goes to the next mode with a left swipe", () => {
    expect(swipeTarget(swipe(-80, 10, 300), 0, 3)).toBe(1);
    expect(swipeTarget(swipe(-80, 10, 300), 1, 3)).toBe(2);
  });

  it("goes to the previous mode with a right swipe", () => {
    expect(swipeTarget(swipe(80, 10, 300), 1, 3)).toBe(0);
    expect(swipeTarget(swipe(80, 10, 300), 2, 3)).toBe(1);
  });

  it("rejects short, vertical and slow gestures", () => {
    expect(swipeTarget(swipe(-59, 0, 300), 0, 3)).toBeNull();
    expect(swipeTarget(swipe(-80, 60, 300), 0, 3)).toBeNull();
    expect(swipeTarget(swipe(-80, 10, 601), 0, 3)).toBeNull();
  });

  it("rejects swipes past the ends", () => {
    expect(swipeTarget(swipe(80, 0, 300), 0, 3)).toBeNull();
    expect(swipeTarget(swipe(-80, 0, 300), 2, 3)).toBeNull();
  });

  it("accepts the exact thresholds", () => {
    expect(swipeTarget(swipe(-60, 40, 600), 0, 3)).toBe(1);
  });

  it("rejects invalid indexes and counts", () => {
    expect(swipeTarget(swipe(-80, 0, 300), -1, 3)).toBeNull();
    expect(swipeTarget(swipe(-80, 0, 300), 3, 3)).toBeNull();
    expect(swipeTarget(swipe(-80, 0, 300), 0, 0)).toBeNull();
  });
});

describe("canStartSwipe", () => {
  it("accepts a target without a blocked ancestor", () => {
    const target = { closest: () => null };
    expect(canStartSwipe(target)).toBe(true);
  });

  it("rejects a target inside a no-swipe zone", () => {
    const target = { closest: () => ({}) };
    expect(canStartSwipe(target)).toBe(false);
  });
});

describe("phone navigation preference", () => {
  it("defaults to tabs when storage is missing", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readPhoneNav()).toBe("tabs");
  });

  it("reads and writes the stored value", () => {
    const store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    });
    writePhoneNav("swipe");
    expect(store.get("spitifo.phoneNav")).toBe("swipe");
    expect(readPhoneNav()).toBe("swipe");
    store.set("spitifo.phoneNav", "otra-cosa");
    expect(readPhoneNav()).toBe("tabs");
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    });
    expect(readPhoneNav()).toBe("tabs");
    expect(() => writePhoneNav("swipe")).not.toThrow();
  });
});
