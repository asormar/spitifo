import { afterEach, describe, expect, it, vi } from "vitest";

/* Node no tiene window/document: cada prueba arma los suyos y reimporta el
   modulo, porque la escucha de "spitifo-screen" y visibilitychange se arma
   una sola vez, al importar. */
function fakeDom(visibility = "visible") {
  const listeners = { window: {}, document: {} };
  const state = { attr: false };
  const win = {
    addEventListener: vi.fn((type, fn) => {
      listeners.window[type] = fn;
    }),
  };
  const doc = {
    visibilityState: visibility,
    addEventListener: vi.fn((type, fn) => {
      listeners.document[type] = fn;
    }),
    documentElement: {
      toggleAttribute: vi.fn((name, force) => {
        state.attr = force;
      }),
    },
  };
  return { win, doc, listeners, state };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("screenState: isScreenOff", () => {
  it("arranca encendida y sigue el evento nativo spitifo-screen", async () => {
    const { win, doc, listeners } = fakeDom();
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    const { isScreenOff } = await import("./screenState.js");
    expect(isScreenOff()).toBe(false);
    listeners.window["spitifo-screen"]({ detail: { on: false } });
    expect(isScreenOff()).toBe(true);
    listeners.window["spitifo-screen"]({ detail: { on: true } });
    expect(isScreenOff()).toBe(false);
  });
});

describe("screenState: isBackgrounded", () => {
  it("es verdad con la pestana tapada aunque la pantalla siga encendida", async () => {
    const { win, doc } = fakeDom("hidden");
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    const { isBackgrounded } = await import("./screenState.js");
    expect(isBackgrounded()).toBe(true);
  });

  it("es verdad con la pantalla apagada aunque la pestana siga visible", async () => {
    const { win, doc, listeners } = fakeDom("visible");
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    const { isBackgrounded } = await import("./screenState.js");
    expect(isBackgrounded()).toBe(false);
    listeners.window["spitifo-screen"]({ detail: { on: false } });
    expect(isBackgrounded()).toBe(true);
  });
});

describe("screenState: <html data-bg>", () => {
  it("se marca y se quita segun las dos senales, para que el CSS pause las animaciones", async () => {
    const { win, doc, listeners, state } = fakeDom("visible");
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    await import("./screenState.js");
    expect(state.attr).toBe(false);
    listeners.window["spitifo-screen"]({ detail: { on: false } });
    expect(state.attr).toBe(true);
    listeners.window["spitifo-screen"]({ detail: { on: true } });
    expect(state.attr).toBe(false);
    doc.visibilityState = "hidden";
    listeners.document.visibilitychange();
    expect(state.attr).toBe(true);
  });
});
