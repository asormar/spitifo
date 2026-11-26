import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSnapshot, readSnapshot, writeSnapshot } from "./sessionSnapshot.js";

const fakeStorage = (values = {}) => ({
  getItem: (k) => (k in values ? values[k] : null),
  setItem: (k, v) => { values[k] = v; },
  removeItem: (k) => { delete values[k]; },
});

const track = (key) => ({ key, src: `/audio/${key}`, title: key, kind: "library" });

describe("sessionSnapshot", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("guarda y lee la pista, la cola y la posicion", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    const A = track("a");
    const B = track("b");
    writeSnapshot(A, [A, B], 42.5);
    const snap = readSnapshot();
    expect(snap.track).toEqual(A);
    expect(snap.queue).toEqual([A, B]);
    expect(snap.index).toBe(0);
    expect(snap.time).toBe(42.5);
  });

  it("sin pista, borra el snapshot en vez de guardar uno vacio", () => {
    const values = {};
    vi.stubGlobal("localStorage", fakeStorage(values));
    writeSnapshot(track("a"), [track("a")], 0);
    expect(readSnapshot()).not.toBeNull();
    writeSnapshot(null, [], 0);
    expect(values["spitifo:session"]).toBeUndefined();
    expect(readSnapshot()).toBeNull();
  });

  it("una cola enorme se recorta: el snapshot se queda ligero", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    const many = Array.from({ length: 500 }, (_, i) => track(`t${i}`));
    writeSnapshot(many[300], many, 10);
    const snap = readSnapshot();
    expect(snap.queue.length).toBeLessThanOrEqual(200);
    /* La pista que sonaba sigue en la cola recortada, con su indice correcto. */
    expect(snap.queue[snap.index].key).toBe("t300");
  });

  it("sin almacenamiento (lleno o bloqueado), no rompe: simplemente no hay nada que leer", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("bloqueado"); },
      setItem: () => { throw new Error("bloqueado"); },
      removeItem: () => { throw new Error("bloqueado"); },
    });
    expect(() => writeSnapshot(track("a"), [track("a")], 0)).not.toThrow();
    expect(readSnapshot()).toBeNull();
    expect(() => clearSnapshot()).not.toThrow();
  });

  it("una version distinta o una pista incompleta no se usan para retomar", () => {
    const values = { "spitifo:session": JSON.stringify({ v: 999, track: track("a"), queue: [], time: 0 }) };
    vi.stubGlobal("localStorage", fakeStorage(values));
    expect(readSnapshot()).toBeNull();

    values["spitifo:session"] = JSON.stringify({ v: 1, track: { key: "a" }, queue: [], time: 0 });
    expect(readSnapshot()).toBeNull();

    values["spitifo:session"] = "{not json";
    expect(readSnapshot()).toBeNull();
  });

  it("clearSnapshot quita el snapshot guardado", () => {
    const values = {};
    vi.stubGlobal("localStorage", fakeStorage(values));
    writeSnapshot(track("a"), [track("a")], 0);
    clearSnapshot();
    expect(readSnapshot()).toBeNull();
  });
});
