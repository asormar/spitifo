import { describe, expect, it } from "vitest";
import { createPendingDeletes } from "./pending.js";

const files = [{ key: "A/a.mp3" }, { key: "A/b.mp3" }, { key: "A/c.mp3" }];

describe("createPendingDeletes", () => {
  it("sin pendientes devuelve la misma lista", () => {
    const p = createPendingDeletes();
    expect(p.filter(files)).toBe(files);
  });

  it("una recarga no trae de vuelta lo que se esta borrando", () => {
    const p = createPendingDeletes();
    p.hide(["A/a.mp3", "A/c.mp3"]);
    expect(p.filter(files).map((f) => f.key)).toEqual(["A/b.mp3"]);
  });

  it("al terminar o deshacer, la clave vuelve a contar", () => {
    const p = createPendingDeletes();
    p.hide(["A/a.mp3", "A/c.mp3"]);
    p.release(["A/a.mp3"]);
    expect(p.filter(files).map((f) => f.key)).toEqual(["A/a.mp3", "A/b.mp3"]);
    p.release(["A/c.mp3"]);
    expect(p.size).toBe(0);
  });

  it("soltar sin nada no rompe", () => {
    const p = createPendingDeletes();
    p.release(undefined);
    expect(p.size).toBe(0);
  });
});
