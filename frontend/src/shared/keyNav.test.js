import { describe, expect, it } from "vitest";
import { listKey, nextIndexForKey } from "./keyNav.js";

describe("nextIndexForKey", () => {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];

  it("mueve una fila y no pasa de los bordes", () => {
    const n = 10;
    expect(keys.map((k) => nextIndexForKey(k, 4, n))).toEqual([5, 3, 0, 9]);
    expect(nextIndexForKey("ArrowDown", 9, n)).toBe(9);
    expect(nextIndexForKey("ArrowUp", 0, n)).toBe(0);
  });

  it("Home y End van al principio y al final", () => {
    expect(nextIndexForKey("Home", 7, 30)).toBe(0);
    expect(nextIndexForKey("End", 2, 30)).toBe(29);
  });

  it("PageDown/PageUp se ignoran en la lista de resultados (page 0)", () => {
    expect(nextIndexForKey("PageDown", 4, 20, 0)).toBe(4);
    expect(nextIndexForKey("PageUp", 4, 20, 0)).toBe(4);
  });

  it("PageDown/PageUp saltan una pagina en la lista virtual", () => {
    expect(nextIndexForKey("PageDown", 4, 100, 10)).toBe(14);
    expect(nextIndexForKey("PageUp", 14, 100, 10)).toBe(4);
    expect(nextIndexForKey("PageDown", 95, 100, 10)).toBe(99);
    expect(nextIndexForKey("PageUp", 3, 100, 10)).toBe(0);
  });

  it("teclas ajenas y lista vacia dejan el indice", () => {
    expect(nextIndexForKey("Enter", 4, 10, 5)).toBe(4);
    expect(nextIndexForKey("Tab", 4, 10, 5)).toBe(4);
    expect(nextIndexForKey("ArrowDown", 0, 0, 5)).toBe(0);
  });
});

describe("listKey", () => {
  const row = (i) => ({ dataset: { index: String(i) }, focus() { this.focused = true; } });
  const ev = (key, i, rows) => ({
    key,
    defaultPrevented: false,
    target: { closest: () => rows[i] },
    currentTarget: { querySelectorAll: () => rows },
    preventDefault() { this.defaultPrevented = true; },
  });

  it("mueve el foco en la lista de resultados", () => {
    const rows = [0, 1, 2].map(row);
    const e = ev("ArrowDown", 0, rows);
    listKey(e, ".res__main");
    expect(e.defaultPrevented).toBe(true);
    expect(rows[1].focused).toBe(true);
  });

  it("respeta el indice real de una fila virtual y avisa al llamador", () => {
    const rows = [5, 6, 7].map(row); // solo la ventana visible
    const seen = [];
    const e = ev("PageDown", 1, rows);
    listKey(e, ".vrow", 100, 10, (n) => seen.push(n));
    expect(seen).toEqual([16]); // 6 (data-index) + 10 (pagina)
    expect(e.defaultPrevented).toBe(true);
  });

  it("ignora teclas ajenas y eventos ya consumidos", () => {
    const rows = [0, 1].map(row);
    const e = ev("Enter", 0, rows);
    listKey(e, ".res__main");
    expect(e.defaultPrevented).toBe(false);
    const used = ev("ArrowDown", 0, rows);
    used.defaultPrevented = true;
    listKey(used, ".res__main");
    expect(rows[1].focused).toBeFalsy();
  });
});
