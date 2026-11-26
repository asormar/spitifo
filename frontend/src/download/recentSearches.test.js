import { describe, expect, it, vi } from "vitest";
import { RECENT_MAX, clearRecent, parseRecent, readRecent, rememberRecent } from "./recentSearches.js";

function fakeStorage(initial = "[]") {
  const data = new Map([["spitifo.search.recent", initial]]);
  return {
    getItem: vi.fn((k) => data.get(k) ?? null),
    setItem: vi.fn((k, v) => data.set(k, v)),
    removeItem: vi.fn((k) => data.delete(k)),
  };
}

describe("recentSearches", () => {
  it("recuerda una busqueda con su modo y la pone primero", () => {
    const s = fakeStorage();
    const next = rememberRecent(s, "Mesmerizer", "sources");
    expect(next[0]).toEqual({ text: "Mesmerizer", mode: "sources" });
    rememberRecent(s, "Rosalía", "matched");
    expect(readRecent(s).map((r) => r.text)).toEqual(["Rosalía", "Mesmerizer"]);
  });

  it("no repite una busqueda aunque cambie la tilde o el modo", () => {
    const s = fakeStorage();
    rememberRecent(s, "Rosalia", "matched");
    const next = rememberRecent(s, "ROSALÍA", "ytdlp");
    expect(next).toHaveLength(1);
    expect(next[0].mode).toBe("ytdlp");
  });

  it("respeta el tope de ocho y descarta datos rotos", () => {
    expect(parseRecent([{ text: "a" }, { text: "" }, null, { text: "a" }])).toHaveLength(1);
    expect(parseRecent("no es una lista")).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => ({ text: `q${i}` }));
    expect(parseRecent(many)).toHaveLength(RECENT_MAX);
  });

  it("sobrevive a un almacen que tira al leer, escribir y borrar", () => {
    const broken = {
      getItem: () => { throw new Error("bloqueado"); },
      setItem: () => { throw new Error("bloqueado"); },
      removeItem: () => { throw new Error("bloqueado"); },
    };
    expect(readRecent(broken)).toEqual([]);
    expect(rememberRecent(broken, "una busqueda")).toEqual([
      { text: "una busqueda", mode: "matched" },
    ]);
    expect(clearRecent(broken)).toEqual([]);
  });

  it("borra el historial y lo deja vacio en el almacen", () => {
    const s = fakeStorage();
    rememberRecent(s, "una busqueda");
    expect(clearRecent(s)).toEqual([]);
    expect(readRecent(s)).toEqual([]);
  });
});
