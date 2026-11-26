import { describe, expect, it } from "vitest";
import { desktopShortcut, isSearchShortcut, isTypingTarget } from "./hotkeys.js";

const key = (o = {}) => ({ key: "k", ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, ...o });

describe("isSearchShortcut", () => {
  it("acepta Ctrl+K y Cmd+K, sin Alt", () => {
    expect(isSearchShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isSearchShortcut(key({ metaKey: true }))).toBe(true);
    expect(isSearchShortcut(key({ ctrlKey: true, metaKey: true }))).toBe(true);
  });

  it("rechaza la tecla sin modificador, con Alt o ya consumida", () => {
    expect(isSearchShortcut(key())).toBe(false);
    expect(isSearchShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSearchShortcut(key({ ctrlKey: true, defaultPrevented: true }))).toBe(false);
    expect(isSearchShortcut(key({ ctrlKey: true, key: "K" }))).toBe(true);
    expect(isSearchShortcut(key({ ctrlKey: true, key: "x" }))).toBe(false);
  });
});

describe("isTypingTarget", () => {
  it("detecta campos de texto y contenido editable", () => {
    expect(isTypingTarget("INPUT", false)).toBe(true);
    expect(isTypingTarget("TEXTAREA", false)).toBe(true);
    expect(isTypingTarget("SELECT", false)).toBe(true);
    expect(isTypingTarget("DIV", true)).toBe(true);
  });

  it("un boton o el cuerpo no cuentan como escritura", () => {
    expect(isTypingTarget("BUTTON", false)).toBe(false);
    expect(isTypingTarget("DIV", false)).toBe(false);
    expect(isTypingTarget(undefined, undefined)).toBe(false);
  });
});

describe("desktopShortcut", () => {
  it("reproduce, busca y mueve la posicion sin modificadores", () => {
    expect(desktopShortcut(key({ key: " " }))).toBe("playPause");
    expect(desktopShortcut(key({ key: "ArrowLeft" }))).toBe("seekBack");
    expect(desktopShortcut(key({ key: "ArrowRight" }))).toBe("seekFwd");
    expect(desktopShortcut(key({ key: "m" }))).toBe("mute");
  });

  it("Ctrl y Cmd cambian de pista, el riel y el panel", () => {
    expect(desktopShortcut(key({ key: "ArrowLeft", ctrlKey: true }))).toBe("prev");
    expect(desktopShortcut(key({ key: "ArrowRight", metaKey: true }))).toBe("next");
    expect(desktopShortcut(key({ key: "\\", ctrlKey: true }))).toBe("rail");
    expect(desktopShortcut(key({ key: "p", ctrlKey: true, shiftKey: true }))).toBe("panel");
  });

  it("la interrogante abre la hoja, incluso con Shift+/", () => {
    expect(desktopShortcut(key({ key: "?" }))).toBe("help");
    expect(desktopShortcut(key({ key: "/", shiftKey: true }))).toBe("help");
  });

  it("no roba teclas con Alt, ya consumidas o que no son atajos", () => {
    expect(desktopShortcut(key({ key: " ", altKey: true }))).toBe(null);
    expect(desktopShortcut(key({ key: " ", defaultPrevented: true }))).toBe(null);
    expect(desktopShortcut(key({ key: "x" }))).toBe(null);
    expect(desktopShortcut(key({ key: " ", ctrlKey: true }))).toBe(null);
  });
});
