import { describe, expect, it } from "vitest";
import { needsProgress, progressOf } from "./searchProgress.js";

const row = (state) => ({ source: "itunes", source_id: state, extra: { match_state: state } });

describe("progressOf", () => {
  it("cuenta como resueltas las filas enteras y las que no tienen version", () => {
    const rows = [row("full"), row("none"), row("pending"), row("lazy")];
    expect(progressOf(rows)).toMatchObject({ resolved: 2, total: 4, pending: 2 });
    expect(progressOf(rows).text).toBe("Buscando versiones completas… 2/4");
  });

  it("acepta un total distinto (el catalogo puede traer mas filas que el estado)", () => {
    expect(progressOf([row("full")], 12)).toMatchObject({ resolved: 1, total: 12, pending: 11 });
  });
});

describe("needsProgress", () => {
  it("se apaga cuando todo resolvio y la respuesta termino", () => {
    expect(needsProgress([row("full"), row("none")], true)).toBe(false);
    expect(needsProgress([row("full"), row("none")], false)).toBe(true);
    expect(needsProgress([row("pending")], true)).toBe(true);
  });
});
