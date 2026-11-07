import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PC_MIN } from "./viewport.js";

/* El CSS no puede importar PC_MIN: este test es el que obliga a que el 960 de
   shell.css siga siendo el mismo numero que usa usePc(). */
const shell = readFileSync(new URL("../app/shell.css", import.meta.url), "utf8");
const queries = [...shell.matchAll(/\((min|max)-width:\s*([\d.]+)px\)/g)].map((m) => [m[1], Number(m[2])]);
const widths = (kind) => queries.filter(([k]) => k === kind).map(([, px]) => px);

describe("umbral de escritorio", () => {
  it("es 960 px", () => {
    expect(PC_MIN).toBe(960);
  });

  it("shell.css usa el mismo umbral en sus media queries de ancho", () => {
    const mins = widths("min");
    const maxes = widths("max");
    expect(mins.length).toBeGreaterThan(0);
    expect(maxes.length).toBeGreaterThan(0);
    expect(new Set(mins)).toEqual(new Set([PC_MIN]));
    /* La mitad de telefono acaba justo antes del umbral. */
    expect(new Set(maxes)).toEqual(new Set([PC_MIN - 0.02]));
  });
});
