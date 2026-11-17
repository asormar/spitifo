import { describe, expect, it } from "vitest";
import { isSearchShortcut, isTypingTarget } from "./hotkeys.js";

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
