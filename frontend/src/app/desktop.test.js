import { describe, expect, it } from "vitest";
import {
  RAIL_COLLAPSED,
  RAIL_DEFAULT,
  RAIL_MAX,
  RAIL_MIN,
  clampPanel,
  clampRail,
  railWidth,
} from "./desktop.js";

describe("clampRail", () => {
  it("respeta el rango 200-320 y redondea", () => {
    expect(clampRail(100)).toBe(RAIL_MIN);
    expect(clampRail(9999)).toBe(RAIL_MAX);
    expect(clampRail(248.6)).toBe(249);
  });

  it("cae al ancho por defecto si no hay numero", () => {
    expect(clampRail(undefined)).toBe(RAIL_DEFAULT);
    expect(clampRail("no")).toBe(RAIL_DEFAULT);
  });
});

describe("clampPanel", () => {
  it("respeta el rango 280-520", () => {
    expect(clampPanel(100)).toBe(280);
    expect(clampPanel(9999)).toBe(520);
    expect(clampPanel(420)).toBe(420);
  });
});

describe("railWidth", () => {
  it("la compacta gana siempre, sin importar el ancho guardado", () => {
    expect(railWidth(true, RAIL_DEFAULT)).toBe(RAIL_COLLAPSED);
    expect(railWidth(true, 320)).toBe(RAIL_COLLAPSED);
    expect(railWidth(false, 260)).toBe(260);
  });
});
