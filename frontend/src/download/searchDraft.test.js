import { describe, expect, it, vi } from "vitest";
import { createSearchDraft, createStore, searchBusy } from "./searchDraft.js";

describe("searchDraft", () => {
  it("empieza vacio y guarda lo escrito", () => {
    const d = createSearchDraft();
    expect(d.get()).toBe("");
    d.set("chopin");
    expect(d.get()).toBe("chopin");
  });

  it("avisa solo cuando el texto cambia", () => {
    const d = createSearchDraft();
    const fn = vi.fn();
    d.subscribe(fn);
    d.set("a");
    d.set("a");
    d.set("ab");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("acepta una funcion como un setState", () => {
    const d = createSearchDraft();
    d.set("ab");
    d.set((cur) => cur + "c");
    expect(d.get()).toBe("abc");
  });

  it("null y undefined dejan el texto vacio", () => {
    const d = createSearchDraft();
    d.set("x");
    d.set(null);
    expect(d.get()).toBe("");
  });

  it("darse de baja corta los avisos", () => {
    const d = createSearchDraft();
    const fn = vi.fn();
    const off = d.subscribe(fn);
    off();
    d.set("x");
    expect(fn).not.toHaveBeenCalled();
  });

  it("createStore guarda cualquier valor y avisa solo si cambia", () => {
    const st = createStore(false, Boolean);
    const fn = vi.fn();
    st.subscribe(fn);
    st.set(true);
    st.set(true);
    st.set(0);
    expect(st.get()).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("searchBusy empieza apagado y solo guarda booleanos", () => {
    expect(searchBusy.get()).toBe(false);
    searchBusy.set("buscando");
    expect(searchBusy.get()).toBe(true);
    searchBusy.set(false);
    expect(searchBusy.get()).toBe(false);
  });
});
