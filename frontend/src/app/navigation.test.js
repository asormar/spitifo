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
  npCloseDelta,
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
import { createLocationToken, createNpHistory } from "./npHistory.js";

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

const sheet = { type: "albumsheet", id: "a1" };

/* Historial falso: una pila de estados con un indice, popstate y go(n). Con
   `defer`, go() solo encola el salto: asi se pueden probar dos acciones en el
   mismo vuelo (doble tap, leaveNp mientras ya hay un unwind en curso). */
function fakeHistory(initial = [null], { defer = false } = {}) {
  let entries = [...initial];
  let at = 0;
  const goes = [];
  const pending = [];
  const listeners = new Set();
  const fire = () => [...listeners].forEach((fn) => fn());
  return {
    get state() {
      return entries[at];
    },
    get length() {
      return entries.length;
    },
    get goes() {
      return goes.slice();
    },
    push(state) {
      entries = [...entries.slice(0, at + 1), state];
      at = entries.length - 1;
    },
    go(n) {
      goes.push(n);
      const next = at + n;
      if (next < 0 || next >= entries.length) return;
      at = next;
      if (defer) pending.push(fire);
      else fire();
    },
    flush() {
      while (pending.length) pending.shift()();
    },
    onPop(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/* El mismo cableado que la app: el popstate de useNav recorta la pila con el
   stackAfterPop real y corre ANTES que el de Ahora suena. Las decisiones las
   toma la maquina; aqui solo se ejecuta el efecto de cerrar el panel. */
function session({ defer = false } = {}) {
  const hist = fakeHistory([null], { defer });
  const events = [];
  let stack = [];
  const np = createNpHistory({
    history: hist,
    /* App corre `then` dentro del efecto de cierre (tras flushSync): el
       historial ya bajo y useNav ya recorto la pila cuando llega aqui. */
    closePanel: (e) => {
      events.push({ kind: "closePanel", ...e });
      e.then?.();
    },
  });
  hist.onPop(() => {
    const d = depthOf(hist.state);
    if (d < stack.length) stack = stackAfterPop(stack, hist.state);
  });
  hist.onPop(np.onPop);
  const push = (view) => {
    stack = [...stack, view];
    hist.push({ [HISTORY_MARK]: stack.length });
  };
  return {
    np,
    hist,
    events,
    push,
    get stack() {
      return stack.slice();
    },
    get state() {
      return hist.state;
    },
    get length() {
      return hist.length;
    },
    openNp() {
      const ok = np.open(stack.length);
      if (ok) np.pushNp();
      return ok;
    },
    leave(fn) {
      return np.leave(fn);
    },
    back() {
      hist.go(-1);
    },
    closeFromMenu() {
      return np.closeFromMenu();
    },
    flush() {
      hist.flush();
    },
    escape() {
      const above = np.entry ? aboveNp(stack, np.depth) : false;
      const result = np.escape(above);
      if (result === "overlay") hist.go(-1);
      return result;
    },
  };
}

describe("Ahora suena: maquina de historial", () => {
  it("npmenu es un overlay, asi que otro menu lo sustituye en su entrada", () => {
    const menu = { type: "npmenu", key: "k", t: { title: "Tema" } };
    expect(isOverlay("npmenu")).toBe(true);
    expect(pageOf([album, menu])).toBe(album);
    expect(replaceTop([album, menu], { type: "ficha" })).toEqual([album, { type: "ficha" }]);
  });

  it("abrir empuja una entrada; un segundo tap no empuja otra y un back cierra", () => {
    const s = session();
    expect(s.openNp()).toBe(true);
    expect(s.state).toEqual(npState(0));
    expect(s.np.entry).toBe(1);
    expect(s.openNp()).toBe(false);
    expect(s.length).toBe(2);
    s.back();
    expect(s.np.entry).toBe(0);
    expect(s.state).toBe(null);
    expect(s.events).toHaveLength(1);
    expect(s.events[0].morph).toBe(true);
    expect(s.events[0].then).toBeNull();
  });

  it("con un menu encima, back solo cierra el menu y el siguiente cierra la vista", () => {
    const s = session();
    s.openNp();
    s.push({ type: "npmenu", key: "k" });
    s.back();
    expect(s.stack).toEqual([]);
    expect(s.state).toEqual(npState(0));
    expect(s.np.entry).toBe(1);
    expect(s.events).toHaveLength(0);
    s.back();
    expect(s.np.entry).toBe(0);
    expect(s.events).toHaveLength(1);
  });

  it("abrir sobre una hoja y retroceder devuelve la hoja sin cerrar la vista", () => {
    const s = session();
    s.push(sheet);
    s.openNp();
    s.push({ type: "npmenu", key: "k" });
    s.back();
    expect(s.stack).toEqual([sheet]);
    expect(s.state).toEqual(npState(1));
    expect(s.np.entry).toBe(1);
    s.back();
    expect(s.stack).toEqual([sheet]);
    expect(s.np.entry).toBe(0);
  });

  it("Escape con menu encima cierra solo el menu; la segunda pulsacion cierra la vista", () => {
    const s = session();
    s.openNp();
    s.push({ type: "npmenu", key: "k" });
    expect(s.escape()).toBe("overlay");
    expect(s.hist.goes).toEqual([-1]);
    expect(s.np.entry).toBe(1);
    expect(s.events).toHaveLength(0);
    expect(s.escape()).toBe(true);
    expect(s.hist.goes).toEqual([-1, -1]);
    expect(s.np.entry).toBe(0);
    expect(s.events[0].morph).toBe(true);
  });

  it("«Ir al álbum» desde el menu: un go, se aterriza debajo de NP y then corre una vez", () => {
    const s = session();
    s.openNp();
    s.push({ type: "npmenu", key: "k" });
    const before = s.length;
    let runs = 0;
    expect(s.leave(() => {
      runs += 1;
      s.push({ type: "albumsheet" });
    })).toBe(true);
    expect(s.hist.goes).toEqual([-2]);
    expect(runs).toBe(1);
    expect(s.stack.map((e) => e.type)).toEqual(["albumsheet"]);
    expect(s.state).toEqual({ [HISTORY_MARK]: 1 });
    expect(s.np.entry).toBe(0);
    expect(s.length).toBe(before - 1);
    expect(s.events).toHaveLength(1);
    expect(s.events[0].then).toBeTypeOf("function");
    s.back();
    expect(s.stack).toEqual([]);
    expect(s.state).toBe(null);
    expect(s.length).toBe(before - 1);
  });

  it("reabrir Ahora suena despues vuelve a empujar una entrada", () => {
    const s = session();
    s.openNp();
    s.push({ type: "npmenu", key: "k" });
    s.leave(() => s.push({ type: "albumsheet" }));
    s.back();
    const before = s.length;
    expect(s.state).toBe(null);
    expect(s.openNp()).toBe(true);
    /* La entrada nueva ocupa el indice que dejo la pagina al cerrarse. */
    expect(s.length).toBe(before);
    expect(s.state).toEqual(npState(0));
    s.back();
    expect(s.np.entry).toBe(0);
    expect(s.stack).toEqual([]);
  });

  it("leaveNp con 0, 1 y 2 hojas encima: una entrada mas que hojas, then una vez", () => {
    for (const n of [0, 1, 2]) {
      const s = session();
      s.openNp();
      for (let i = 0; i < n; i += 1) s.push({ type: `sheet${i}` });
      let runs = 0;
      s.leave(() => {
        runs += 1;
      });
      expect(s.hist.goes).toEqual([-(n + 1)]);
      expect(runs).toBe(1);
      expect(s.np.entry).toBe(0);
      expect(s.stack).toEqual([]);
      expect(s.state).toBe(null);
    }
  });

  it("leaveNp desde una hoja sobre una pagina conserva la pagina debajo", () => {
    const s = session();
    s.push(sheet);
    s.push({ type: "albumsheet" });
    s.openNp();
    s.push({ type: "npmenu", key: "k" });
    s.leave(() => {});
    expect(s.hist.goes).toEqual([-2]);
    expect(s.stack).toEqual([sheet, { type: "albumsheet" }]);
    expect(s.state).toEqual({ [HISTORY_MARK]: 2 });
  });

  it("«Cerrar reproductor» deshace menu y vista en un solo go sin morph", () => {
    const s = session();
    s.openNp();
    s.push({ type: "npmenu", key: "k" });
    s.closeFromMenu();
    expect(s.hist.goes).toEqual([-2]);
    expect(s.np.entry).toBe(0);
    expect(s.events).toHaveLength(1);
    expect(s.events[0].morph).toBe(false);
    expect(s.events[0].then).toBeNull();
  });

  it("doble tap de «Cerrar reproductor»: un solo go y un solo cierre", () => {
    const s = session({ defer: true });
    s.openNp();
    s.push({ type: "npmenu", key: "k" });
    s.closeFromMenu();
    s.closeFromMenu();
    expect(s.hist.goes).toEqual([-2]);
    s.flush();
    expect(s.events).toHaveLength(1);
    expect(s.np.entry).toBe(0);
  });

  it("leaveNp durante un unwind no pide otro go y gana el ultimo then", () => {
    const s = session({ defer: true });
    s.openNp();
    s.push({ type: "npmenu", key: "k" });
    const order = [];
    s.leave(() => order.push("primero"));
    s.leave(() => order.push("ultimo"));
    expect(s.hist.goes).toEqual([-2]);
    s.flush();
    expect(order).toEqual(["ultimo"]);
    expect(s.events).toHaveLength(1);
  });

  it("«Cerrar reproductor» descarta un then pendiente", () => {
    const s = session({ defer: true });
    s.openNp();
    s.push({ type: "npmenu", key: "k" });
    let ran = 0;
    s.leave(() => {
      ran += 1;
    });
    s.closeFromMenu();
    s.flush();
    expect(ran).toBe(0);
    expect(s.hist.goes).toEqual([-2]);
  });

  it("el then corre despues de que useNav haya recortado la pila", () => {
    const s = session();
    s.openNp();
    s.push({ type: "npmenu", key: "k" });
    s.leave(() => {
      expect(s.stack).toEqual([]);
      expect(s.np.entry).toBe(0);
    });
    expect(s.events).toHaveLength(1);
  });

  it("escritorio sin entrada: leave no se hace cargo, no hay go y el menu cierra directo", () => {
    const s = session();
    s.push({ type: "menu", key: "k" });
    expect(s.leave(() => {})).toBe(false);
    expect(s.hist.goes).toEqual([]);
    expect(s.closeFromMenu()).toBe("desktop");
    expect(s.hist.goes).toEqual([]);
    expect(s.events).toHaveLength(1);
    expect(s.events[0].direct).toBe(true);
    expect(s.escape()).toBe(false);
    expect(s.hist.goes).toEqual([]);
  });

  it("close sin entrada cierra directo, sin animacion ni historial", () => {
    const s = session();
    s.np.close();
    expect(s.hist.goes).toEqual([]);
    expect(s.events).toEqual([{ kind: "closePanel", then: null, morph: false, direct: true }]);
  });
});

describe("npCloseDelta: cuantas entradas se deshacen", () => {
  it("una mas que las hojas encima, nunca menos de una", () => {
    expect(npCloseDelta(0, 0)).toBe(1);
    expect(npCloseDelta(1, 0)).toBe(2);
    expect(npCloseDelta(2, 0)).toBe(3);
    expect(npCloseDelta(3, 2)).toBe(2);
    expect(npCloseDelta(1, 2)).toBe(1);
  });
});

describe("createLocationToken: sigue donde empezo la accion asincrona", () => {
  it("cambia con el atras, con el popstate y con el estado de Ahora suena", () => {
    const s = session();
    const gen = { current: 0 };
    const token = createLocationToken({ getStack: () => s.stack, np: s.np, gen });
    s.openNp();
    s.push({ type: "npmenu", key: "k" });
    const start = token();
    expect(token()).toBe(start);

    s.back(); /* se cierra el menu, pero Ahora suena sigue abierta */
    expect(s.np.entry).toBe(1);
    expect(token()).not.toBe(start);
    const afterBack = token();

    gen.current += 1; /* el popstate real tambien sube el contador */
    expect(token()).not.toBe(afterBack);
    const afterPop = token();

    s.np.close();
    expect(s.np.entry).toBe(0);
    expect(token()).not.toBe(afterPop);
  });

  it("cambia cuando la navegacion sustituye la entrada de arriba", () => {
    const s = session();
    const gen = { current: 0 };
    const token = createLocationToken({ getStack: () => s.stack, np: s.np, gen });
    s.push({ type: "menu", key: "uno" });
    const start = token();
    s.push({ type: "menu", key: "otro" });
    expect(token()).not.toBe(start);
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
