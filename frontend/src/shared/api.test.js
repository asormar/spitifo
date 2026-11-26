import { afterEach, describe, expect, it, vi } from "vitest";
import { errMsg, fetchErr } from "./api.js";

/* ---------------------------------------------------------------------------
   fetchErr: "sin conexion" y "el servidor no responde" son frases distintas,
   elegidas con la misma senal que useOnline() (navigator.onLine).
   ------------------------------------------------------------------------- */

describe("fetchErr", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("con red, el fallo de fetch es el servidor sin responder", () => {
    vi.stubGlobal("navigator", { onLine: true });
    const e = new TypeError("Failed to fetch");
    expect(fetchErr(e, "fallback")).toBe("El servidor no responde. Vuelve a intentarlo.");
  });

  it("sin red, el mismo fallo de fetch es la frase de sin conexion", () => {
    vi.stubGlobal("navigator", { onLine: false });
    const e = new TypeError("Failed to fetch");
    expect(fetchErr(e, "fallback")).toBe("Sin conexión. Revisa tu red.");
  });

  it("un error que no es de red cae en el fallback", () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(fetchErr(new Error("algo distinto"), "fallback")).toBe("fallback");
  });
});

describe("errMsg", () => {
  it("usa el detail cuando es un string", () => {
    expect(errMsg({ detail: "no se pudo" }, "fallback")).toBe("no se pudo");
  });

  it("aplana un detail de FastAPI (array de errores de validacion)", () => {
    expect(errMsg({ detail: [{ msg: "a" }, { msg: "b" }] }, "fallback")).toBe("a; b");
  });

  it("sin detail util, el fallback", () => {
    expect(errMsg({}, "fallback")).toBe("fallback");
    expect(errMsg(null, "fallback")).toBe("fallback");
  });
});
