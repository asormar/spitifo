import { describe, expect, it } from "vitest";
import {
  HISTORY_MARK,
  depthOf,
  isNpEntry,
  npState,
  stackAfterPop,
  truncate,
  viewKey,
  writeView,
} from "./navigation.js";

/*
  Contrato del atras fisico de Android, tal como esta hoy.

  MainActivity.onBackPressed() llama a WebView.goBack(): eso dispara un
  popstate normal, sin pila nativa ni puente. useNav escucha ese popstate
  ANTES que "Ahora suena" y recorta la pila con la profundidad guardada en
  history.state (HISTORY_MARK). Estas pruebas fijan esa mecanica para que el
  espejo de rutas de la fase 14 no la cambie: ninguna de ellas puede fallar
  despues de anadir direcciones a las paginas.
*/

/* Historial falso con la misma forma de actuar que WebView.goBack(): go(-1)
   solo dispara popstate si queda una entrada a la que volver. */
function androidHistory(initial = [null]) {
  let entries = [...initial];
  let at = 0;
  const calls = [];
  const listeners = new Set();
  const fire = () => [...listeners].forEach((fn) => fn());
  return {
    get state() {
      return entries[at];
    },
    get length() {
      return entries.length;
    },
    get at() {
      return at;
    },
    get calls() {
      return calls.slice();
    },
    push(state, url) {
      entries = [...entries.slice(0, at + 1), state];
      at = entries.length - 1;
      calls.push({ op: "push", at });
    },
    replace(state, url) {
      entries[at] = state;
      calls.push({ op: "replace", at });
    },
    go(n) {
      const next = at + n;
      if (next < 0 || next >= entries.length) {
        calls.push({ op: "go", n, effect: "none" });
        return "none";
      }
      at = next;
      calls.push({ op: "go", n, at });
      fire();
      return "pop";
    },
    onPop(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/* El mismo cableado que useNav: la pila se recorta con stackAfterPop, que
   lee la profundidad del estado de la entrada alcanzada. */
function session() {
  const hist = androidHistory();
  let stack = [];
  hist.onPop(() => {
    if (depthOf(hist.state) < stack.length) {
      stack = stackAfterPop(stack, hist.state);
    }
  });
  return {
    hist,
    get stack() {
      return stack.slice();
    },
    open(view) {
      stack = [...stack, view];
      hist.push({ [HISTORY_MARK]: stack.length }, "");
    },
    back() {
      return hist.go(-1);
    },
  };
}

const album = { type: "album", id: "168" };
const artist = { type: "artist", id: "9" };
const list = { type: "list", id: "4" };

describe("atras de Android: popstate y profundidad", () => {
  it("cada pagina abierta empuja una entrada y un back cierra solo la ultima", () => {
    const s = session();
    s.open(album);
    s.open(artist);
    s.open(list);
    expect(s.hist.length).toBe(4);
    expect(s.stack).toEqual([album, artist, list]);
    expect(depthOf(s.hist.state)).toBe(3);

    expect(s.back()).toBe("pop");
    expect(s.stack).toEqual([album, artist]);
    expect(depthOf(s.hist.state)).toBe(2);

    s.back();
    expect(s.stack).toEqual([album]);
    s.back();
    expect(s.stack).toEqual([]);
  });

  it("en la raiz no hay popstate: WebView.goBack() sale de la app", () => {
    const s = session();
    expect(s.back()).toBe("none");
    expect(s.stack).toEqual([]);
    expect(s.hist.calls).toEqual([{ op: "go", n: -1, effect: "none" }]);
  });

  it("un popstate a una profundidad mayor no toca la pila", () => {
    const s = session();
    s.open(album);
    s.open(artist);
    const before = s.stack;
    /* Entrada adelante con mas profundidad de la que tiene la pila. */
    s.hist.push({ [HISTORY_MARK]: 9 }, "");
    expect(s.back()).toBe("pop");
    expect(s.stack).toEqual(before);
  });

  it("stackAfterPop solo recorta, nunca anade entradas", () => {
    expect(stackAfterPop([album, artist, list], { [HISTORY_MARK]: 1 })).toEqual([album]);
    expect(stackAfterPop([album], { [HISTORY_MARK]: 0 })).toEqual([]);
    const stack = [album, artist];
    expect(stackAfterPop(stack, { [HISTORY_MARK]: 5 })).toBe(stack);
    expect(truncate(stack, 5)).toBe(stack);
  });
});

describe("Ahora suena comparte la mecanica sin cambiarla", () => {
  it("la entrada de la vista guarda la profundidad que tenia la pila", () => {
    const s = session();
    s.open(album);
    const state = npState(s.stack.length);
    expect(isNpEntry(state)).toBe(true);
    expect(depthOf(state)).toBe(1);
  });

  it("aterrizar en la entrada de la vista no cierra la pagina de debajo", () => {
    const s = session();
    s.open(album);
    /* Abrir la vista empuja su entrada y encima se abre un menu. */
    s.hist.push(npState(1), "");
    s.hist.push({ [HISTORY_MARK]: 2 }, "");
    expect(s.back()).toBe("pop");
    expect(s.stack).toEqual([album]);
    expect(isNpEntry(s.hist.state)).toBe(true);
    expect(s.back()).toBe("pop");
    expect(s.stack).toEqual([album]);
  });
});

describe("cambiar de pestana nunca ha tocado el historial", () => {
  it("writeView solo reescribe la URL: replaceState no cambia el tamano", () => {
    const hist = androidHistory([null]);
    hist.push({ [HISTORY_MARK]: 1 }, "");
    const before = hist.length;
    const url = writeView("?view=home&q=rosalia", { tab: "library" });
    hist.replace(null, url);
    expect(hist.length).toBe(before);
    expect(hist.at).toBe(1);
    expect(hist.calls.at(-1).op).toBe("replace");
    expect(url).toBe("?view=library&q=rosalia");
  });

  it("las claves de scroll sobreviven a hojas y menus encima de la pagina", () => {
    const menu = { type: "menu", key: "k1" };
    expect(viewKey("library", [album])).toBe("library/album:168");
    expect(viewKey("library", [album, menu])).toBe("library/album:168");
    expect(viewKey("library", [album, { type: "settings", focus: null }])).toBe("settings");
  });
});
