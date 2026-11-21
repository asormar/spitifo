import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_MARK,
  TABS,
  aboveNp,
  canStartSwipe,
  depthOf,
  isNpEntry,
  isOverlay,
  modeDirection,
  nextGuess,
  npCloseUnwind,
  npState,
  pageOf,
  readPhoneNav,
  readView,
  replaceTop,
  stackAfterPop,
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

  it("skips the file sheet, which is not the Buscar ficha", () => {
    const file = { type: "file", key: "k1" };
    expect(pageOf([album, { type: "menu", key: "k1" }, file])).toBe(album);
    expect(pageOf([file])).toBeNull();
  });

  it("skips the album sheet and the queue sheet, but keeps the album page", () => {
    const sheet = { type: "albumsheet", id: "a1" };
    const downloads = { type: "descargas" };
    expect(pageOf([sheet])).toBeNull();
    expect(pageOf([downloads])).toBeNull();
    expect(pageOf([album, sheet, downloads])).toBe(album);
  });
});

describe("isOverlay", () => {
  it("is true for the song menu, the list menu, the picker and the file sheet only", () => {
    expect(["menu", "picker", "lmenu", "file", "art"].every(isOverlay)).toBe(true);
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

  it("the Ahora suena entry carries the depth the stack had when it opened", () => {
    const state = npState(2);
    expect(state).toEqual({ spitifo: "np", [HISTORY_MARK]: 2 });
    expect(depthOf(state)).toBe(2);
    expect(isNpEntry(state)).toBe(true);
    expect(isNpEntry({ [HISTORY_MARK]: 2 })).toBe(false);
  });
});

describe("Ahora suena: pila e historial", () => {
  const sheet = { type: "albumsheet", id: "a1" };
  const menu = { type: "npmenu", t: { title: "Tema" } };

  /* Modelo de lo que hacen useNav y App con un popstate: la pila se recorta a
     la profundidad de la entrada alcanzada, y Ahora suena solo se cierra si la
     entrada NO es la suya. */
  const pop = (stack, state, npOpen) => ({
    stack: stackAfterPop(stack, state),
    npOpen: npOpen && isNpEntry(state),
  });

  it("with a menu over Ahora suena, back closes only the menu", () => {
    const landed = pop([sheet, menu], npState(1), true);
    expect(landed.stack).toEqual([sheet]);
    expect(landed.npOpen).toBe(true);
  });

  it("back again closes Ahora suena and keeps the view underneath", () => {
    const afterMenu = pop([sheet, menu], npState(1), true);
    const landed = pop(afterMenu.stack, { [HISTORY_MARK]: 1 }, afterMenu.npOpen);
    expect(landed.stack).toEqual([sheet]);
    expect(landed.npOpen).toBe(false);
  });

  it("Escape closes the smallest thing first", () => {
    expect(aboveNp([sheet, menu], 1)).toBe(true);
    expect(aboveNp([sheet], 1)).toBe(false);
    expect(aboveNp([], 0)).toBe(false);
  });

  it("opening Ahora suena from a sheet and backing out restores the sheet", () => {
    const stack = [album, sheet];
    const depth = stack.length;
    const withMenu = [...stack, menu];
    const afterMenu = pop(withMenu, npState(depth), true);
    expect(afterMenu.stack).toEqual(stack);
    expect(afterMenu.npOpen).toBe(true);
    const afterNp = pop(afterMenu.stack, { [HISTORY_MARK]: depth }, afterMenu.npOpen);
    expect(afterNp.stack).toEqual(stack);
    expect(afterNp.npOpen).toBe(false);
  });

  it("npmenu is an overlay, so another openMenu replaces it instead of pushing", () => {
    expect(isOverlay("npmenu")).toBe(true);
    expect(pageOf([album, menu])).toBe(album);
    expect(replaceTop([album, menu], { ...menu, t: { title: "Otra" } })).toEqual([
      album,
      { ...menu, t: { title: "Otra" } },
    ]);
  });
});

describe("npCloseUnwind: cerrar Ahora suena desde una hoja", () => {
  it("con el menu encima deshace el menu y la vista en un solo go", () => {
    /* «Ir al álbum» desde el ⋯: pila [npmenu], vista abierta en profundidad 0. */
    expect(npCloseUnwind(1, 0)).toEqual({ above: 1, delta: 2, landingDepth: 0 });
  });

  it("leaveNp con 0, 1 y 2 hojas encima: una entrada mas que hojas", () => {
    expect(npCloseUnwind(0, 0).delta).toBe(1);
    expect(npCloseUnwind(1, 0).delta).toBe(2);
    expect(npCloseUnwind(2, 0).delta).toBe(3);
    /* Con la vista abierta sobre una pagina, el aterrizaje es esa pagina. */
    expect(npCloseUnwind(3, 2)).toEqual({ above: 1, delta: 2, landingDepth: 2 });
    expect(npCloseUnwind(1, 2).delta).toBe(1); /* nunca menos de una */
  });

  /* Modelo minimo del par App/useNav: historial de estados, pila de paginas y
     el par de oyentes de popstate. Sirve para comprobar el ciclo completo sin
     React ni DOM. */
  const session = () => {
    let hist = [null];
    let at = 0;
    let stack = [];
    let np = 0;
    let depth = 0;
    let then = null;
    let pushes = 0;

    const state = () => hist[at];
    const push = (s) => {
      hist = [...hist.slice(0, at + 1), s];
      at = hist.length - 1;
      pushes += 1;
    };
    const onPop = () => {
      const d = depthOf(state());
      if (d < stack.length) stack = stackAfterPop(stack, state());
      if (np && !isNpEntry(state())) {
        np = 0;
        const fn = then;
        then = null;
        fn?.();
      }
    };
    const go = (n) => {
      at -= n;
      onPop();
    };
    return {
      get length() {
        return hist.length;
      },
      get state() {
        return state();
      },
      get stack() {
        return stack.slice();
      },
      get np() {
        return np;
      },
      get pushes() {
        return pushes;
      },
      get open() {
        return np === 1;
      },
      openNp() {
        if (np) return false;
        np = 1;
        depth = stack.length;
        push(npState(depth));
        return true;
      },
      overlay(type) {
        stack = [...stack, { type }];
        push({ [HISTORY_MARK]: stack.length });
      },
      page(type) {
        stack = [...stack, { type }];
        push({ [HISTORY_MARK]: stack.length });
      },
      leave(fn) {
        if (!np) return false;
        then = fn ?? null;
        if (np === 1) {
          np = 2;
          go(npCloseUnwind(stack.length, depth).delta);
        }
        return true;
      },
      back() {
        go(1);
      },
    };
  };

  it("«Ir al álbum» desde el menu: cierra NP, abre la pagina y el back siguiente la cierra", () => {
    const s = session();
    s.openNp();
    s.overlay("npmenu");
    const before = s.length;
    s.leave(() => s.page("albumsheet"));
    expect(s.stack.map((e) => e.type)).toEqual(["albumsheet"]);
    expect(s.state).toEqual({ [HISTORY_MARK]: 1 });
    expect(s.np).toBe(0);
    expect(s.length).toBe(before - 1); /* menu + vista fuera, pagina dentro */
    s.back();
    expect(s.stack).toEqual([]);
    expect(s.state).toBe(null);
    expect(s.length).toBe(before - 1); /* el back baja, no borra la entrada */
  });

  it("reabrir Ahora suena despues vuelve a empujar una entrada", () => {
    const s = session();
    s.openNp();
    s.overlay("npmenu");
    s.leave(() => s.page("albumsheet"));
    s.back(); /* cierra la hoja y vuelve a la raiz */
    const pushes = s.pushes;
    expect(s.state).toBe(null);
    expect(s.openNp()).toBe(true);
    expect(s.pushes).toBe(pushes + 1); /* entrada nueva, no se queda pegada */
    expect(s.state).toEqual(npState(0));
    s.back();
    expect(s.open).toBe(false);
    expect(s.np).toBe(0);
    expect(s.stack).toEqual([]);
  });

  it("leaveNp con 0, 1 y 2 hojas encima corre then una vez y deja la pila en la base", () => {
    for (const n of [0, 1, 2]) {
      const s = session();
      s.openNp();
      for (let i = 0; i < n; i += 1) s.overlay(`sheet${i}`);
      let runs = 0;
      s.leave(() => {
        runs += 1;
      });
      expect(runs).toBe(1);
      expect(s.np).toBe(0);
      expect(s.open).toBe(false);
      expect(s.stack).toEqual([]);
      expect(s.state).toBe(null);
    }
  });

  it("escritorio sin entrada de Ahora suena: nada que deshacer, el menu cierra con un back", () => {
    const s = session();
    s.overlay("menu");
    expect(s.leave(() => {})).toBe(false);
    s.back();
    expect(s.stack).toEqual([]);
    expect(s.np).toBe(0);
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
