import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_MARK,
  TABS,
  canStartSwipe,
  depthOf,
  isOverlay,
  modeDirection,
  nextGuess,
  pageOf,
  readPhoneNav,
  readView,
  replaceTop,
  stackFor,
  swipeTarget,
  truncate,
  viewKey,
  writePhoneNav,
  writeView,
} from "./navigation.js";

const params = (search) => new URLSearchParams(search);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readView", () => {
  it("opens on Inicio without a view", () => {
    expect(readView("")).toEqual({ tab: "home", settings: false });
    expect(readView("?utm=1")).toEqual({ tab: "home", settings: false });
  });

  it("reads every tab", () => {
    TABS.forEach((tab) => {
      expect(readView(`?view=${tab}`)).toEqual({ tab, settings: false });
    });
  });

  it("keeps the old links: listen is Inicio and download is Buscar", () => {
    expect(readView("?view=listen")).toEqual({ tab: "home", settings: false });
    expect(readView("?view=download")).toEqual({ tab: "search", settings: false });
  });

  it("lands on Buscar for old shared searches", () => {
    expect(readView("?q=chopin&mode=itunes")).toEqual({ tab: "search", settings: false });
    expect(readView("?mode=ytdlp")).toEqual({ tab: "search", settings: false });
    expect(readView("?src=ytdlp")).toEqual({ tab: "search", settings: false });
    expect(readView("?view=radio&q=x")).toEqual({ tab: "search", settings: false });
  });

  it("lets an explicit view win over the search parameters", () => {
    expect(readView("?view=home&q=x")).toEqual({ tab: "home", settings: false });
    expect(readView("?view=library&q=x&mode=ytdlp")).toEqual({ tab: "library", settings: false });
  });

  it("treats settings as a page over Inicio", () => {
    expect(readView("?view=settings&mode=ytdlp&q=x")).toEqual({ tab: "home", settings: true });
  });

  it("ignores an unknown view", () => {
    expect(readView("?view=radio")).toEqual({ tab: "home", settings: false });
  });
});

describe("writeView", () => {
  it("drops view for Inicio", () => {
    expect(writeView("?view=library", { tab: "home", settings: false })).toBe("");
  });

  it("writes view=home only when a search would make Inicio read as Buscar", () => {
    const out = writeView("?mode=ytdlp&q=hola", { tab: "home" });
    expect(params(out).get("view")).toBe("home");
    expect(params(out).get("q")).toBe("hola");
    expect(readView(out)).toEqual({ tab: "home", settings: false });
    expect(params(writeView("?src=ytdlp", { tab: "home" })).get("view")).toBe("home");
  });

  it("keeps mode and q when the tab changes", () => {
    const out = writeView("?mode=ytdlp&q=hola", { tab: "library", settings: false });
    expect(params(out).get("view")).toBe("library");
    expect(params(out).get("mode")).toBe("ytdlp");
    expect(params(out).get("q")).toBe("hola");
  });

  it("writes settings without dropping the rest", () => {
    const out = writeView("?view=library&mode=ytdlp&q=hola", { tab: "home", settings: true });
    expect(params(out).get("view")).toBe("settings");
    expect(params(out).get("mode")).toBe("ytdlp");
    expect(params(out).get("q")).toBe("hola");
  });

  it("accepts a bare tab", () => {
    expect(writeView("", "discover")).toBe("?view=discover");
    expect(writeView("?view=discover", "home")).toBe("");
  });

  it("ignores an unknown tab", () => {
    expect(writeView("?view=library", { tab: "radio" })).toBe("");
  });

  it("round-trips with readView for every tab, with and without a search", () => {
    TABS.forEach((tab) => {
      ["", "?q=x&mode=itunes"].forEach((search) => {
        const out = writeView(search, { tab, settings: false });
        expect(readView(out)).toEqual({ tab, settings: false });
      });
    });
    const out = writeView("?q=x", { tab: "home", settings: true });
    expect(readView(out)).toEqual({ tab: "home", settings: true });
  });
});

describe("nextGuess", () => {
  it("preloads the most likely neighbour", () => {
    expect(nextGuess("home")).toBe("search");
    expect(nextGuess("search")).toBe("library");
    expect(nextGuess("library")).toBe("search");
    expect(nextGuess("discover")).toBe("library");
  });
});

describe("modeDirection", () => {
  it("follows the TABS order", () => {
    expect(modeDirection("home", "search")).toBe(1);
    expect(modeDirection("search", "discover")).toBe(1);
    expect(modeDirection("library", "search")).toBe(-1);
    expect(modeDirection("discover", "home")).toBe(-1);
  });

  it("stays still on the same tab", () => {
    expect(modeDirection("library", "library")).toBe(0);
  });

  it("returns 0 when either side is not a tab", () => {
    expect(modeDirection("settings", "library")).toBe(0);
    expect(modeDirection("home", "settings")).toBe(0);
    expect(modeDirection("np", "home")).toBe(0);
    expect(modeDirection(undefined, "discover")).toBe(0);
  });
});

const album = { type: "album", id: "a1" };
const artist = { type: "artist", id: "r1" };
const settings = { type: "settings", focus: null };
const search = { type: "search" };

describe("pageOf", () => {
  it("is null on a root", () => {
    expect(pageOf([])).toBeNull();
  });

  it("is the top page", () => {
    expect(pageOf([album, artist])).toBe(artist);
  });

  it("skips settings and the library-search mark", () => {
    expect(pageOf([album, settings])).toBe(album);
    expect(pageOf([search])).toBeNull();
    expect(pageOf([search, settings])).toBeNull();
    expect(pageOf([search, album])).toBe(album);
  });

  it("skips the Buscar sheets (ficha and resolution menu)", () => {
    const ficha = { type: "ficha", key: "itunes1" };
    const menu = { type: "resmenu", key: "itunes1" };
    expect(pageOf([ficha])).toBeNull();
    expect(pageOf([ficha, menu])).toBeNull();
    expect(pageOf([album, ficha])).toBe(album);
  });

  it("skips the library overlays (song menu, list menu and picker)", () => {
    const menu = { type: "menu", key: "k1" };
    const picker = { type: "picker", key: "k1" };
    const lmenu = { type: "lmenu", key: "p1" };
    expect(pageOf([menu])).toBeNull();
    expect(pageOf([album, menu])).toBe(album);
    expect(pageOf([album, menu, picker])).toBe(album);
    expect(pageOf([album, lmenu])).toBe(album);
  });
});

describe("isOverlay", () => {
  it("is true for the song menu, the list menu and the picker only", () => {
    expect(["menu", "picker", "lmenu"].every(isOverlay)).toBe(true);
    expect(["album", "artist", "all", "library", "settings", "search", "ficha", "resmenu"].some(isOverlay)).toBe(false);
  });
});

describe("replaceTop", () => {
  it("swaps the entry on top and keeps the ones below", () => {
    const menu = { type: "menu", key: "k1" };
    const picker = { type: "picker", key: "k1" };
    expect(replaceTop([album, menu], picker)).toEqual([album, picker]);
    expect(replaceTop([menu], album)).toEqual([album]);
  });

  it("does not touch the stack it receives", () => {
    const stack = [album, { type: "menu", key: "k1" }];
    replaceTop(stack, artist);
    expect(stack).toHaveLength(2);
  });

  it("opens the view over an empty stack", () => {
    expect(replaceTop([], album)).toEqual([album]);
  });
});

describe("stackFor", () => {
  it("gives the stack to the active tab only", () => {
    const stack = [album];
    expect(stackFor("library", "library", stack)).toBe(stack);
    expect(stackFor("home", "library", stack)).toEqual([]);
  });
});

describe("truncate", () => {
  it("cuts the stack to the depth the history went back to", () => {
    expect(truncate([album, artist, settings], 1)).toEqual([album]);
    expect(truncate([album, artist], 0)).toEqual([]);
  });

  it("keeps the same stack when the depth does not drop", () => {
    const stack = [album, artist];
    expect(truncate(stack, 2)).toBe(stack);
    expect(truncate(stack, 5)).toBe(stack);
  });

  it("never goes below empty", () => {
    expect(truncate([album], -1)).toEqual([]);
  });
});

describe("viewKey", () => {
  it("is the tab on a root", () => {
    expect(viewKey("library", [])).toBe("library");
    expect(viewKey("library", [search])).toBe("library");
  });

  it("separates each page of a tab", () => {
    expect(viewKey("home", [album])).toBe("home/album:a1");
    expect(viewKey("home", [{ type: "all", what: "albums" }])).toBe("home/all:albums");
    expect(viewKey("library", [album])).not.toBe(viewKey("home", [album]));
  });

  it("ignores the sheets on top of a page or a root", () => {
    const ficha = { type: "ficha", key: "k" };
    expect(viewKey("search", [ficha])).toBe("search");
    expect(viewKey("home", [album, ficha])).toBe("home/album:a1");
  });

  it("keeps the scroll of the page under an overlay", () => {
    const menu = { type: "menu", key: "k1" };
    expect(viewKey("home", [album, menu])).toBe("home/album:a1");
    expect(viewKey("home", [menu])).toBe("home");
  });

  it("is settings while Ajustes is on top", () => {
    expect(viewKey("home", [settings])).toBe("settings");
    expect(viewKey("library", [album, settings])).toBe("settings");
  });
});

describe("history mark", () => {
  it("reads the depth of an entry", () => {
    expect(depthOf({ [HISTORY_MARK]: 2 })).toBe(2);
    expect(depthOf({ spitifo: "np" })).toBe(0);
    expect(depthOf(null)).toBe(0);
    expect(depthOf({ [HISTORY_MARK]: "x" })).toBe(0);
  });
});

describe("swipeTarget", () => {
  const swipe = (dx, dy, dt) => ({ dx, dy, dt });

  it("goes to the next tab with a left swipe", () => {
    expect(swipeTarget(swipe(-80, 10, 300), 0, 4)).toBe(1);
    expect(swipeTarget(swipe(-80, 10, 300), 2, 4)).toBe(3);
  });

  it("goes to the previous tab with a right swipe", () => {
    expect(swipeTarget(swipe(80, 10, 300), 1, 4)).toBe(0);
    expect(swipeTarget(swipe(80, 10, 300), 3, 4)).toBe(2);
  });

  it("rejects short, vertical and slow gestures", () => {
    expect(swipeTarget(swipe(-59, 0, 300), 0, 4)).toBeNull();
    expect(swipeTarget(swipe(-80, 60, 300), 0, 4)).toBeNull();
    expect(swipeTarget(swipe(-80, 10, 601), 0, 4)).toBeNull();
  });

  it("rejects swipes past the ends", () => {
    expect(swipeTarget(swipe(80, 0, 300), 0, 4)).toBeNull();
    expect(swipeTarget(swipe(-80, 0, 300), 3, 4)).toBeNull();
  });

  it("moves both ways from the middle of three tabs (Ahora suena)", () => {
    expect(swipeTarget(swipe(-80, 10, 300), 1, 3)).toBe(2);
    expect(swipeTarget(swipe(80, 10, 300), 1, 3)).toBe(0);
    expect(swipeTarget(swipe(-80, 10, 300), 2, 3)).toBeNull();
  });

  it("accepts the exact thresholds", () => {
    expect(swipeTarget(swipe(-60, 40, 600), 0, 4)).toBe(1);
  });

  it("rejects invalid indexes and counts", () => {
    expect(swipeTarget(swipe(-80, 0, 300), -1, 4)).toBeNull();
    expect(swipeTarget(swipe(-80, 0, 300), 4, 4)).toBeNull();
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
