import { describe, expect, it } from "vitest";
import { shouldShowFirstRun } from "./firstRun.js";

/* La decision de si se pinta la tarjeta es pura: no depende de React, del
   almacenamiento ni del reloj. El valor guardado es null (sin decidir),
   "dismissed" (Entendido) o "show" (pedido desde Ajustes). */

describe("shouldShowFirstRun", () => {
  it("sin valor guardado solo se muestra con la biblioteca vacia", () => {
    expect(shouldShowFirstRun(0, null)).toBe(true);
    expect(shouldShowFirstRun(1, null)).toBe(false);
    expect(shouldShowFirstRun(25, null)).toBe(false);
  });

  it("descartada no se muestra aunque la biblioteca este vacia", () => {
    expect(shouldShowFirstRun(0, "dismissed")).toBe(false);
    expect(shouldShowFirstRun(3, "dismissed")).toBe(false);
  });

  it("pedida desde Ajustes se muestra siempre, aunque la biblioteca tenga canciones", () => {
    expect(shouldShowFirstRun(0, "show")).toBe(true);
    expect(shouldShowFirstRun(12, "show")).toBe(true);
  });
});
