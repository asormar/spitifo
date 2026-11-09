import { describe, expect, it } from "vitest";
import { connectErrorText, cookieStatus, driveSub, fmtGB, quotaView } from "./storageInfo.js";

/* La logica de Ajustes que antes vivia dentro de los componentes, donde no se
   puede probar sin DOM. Todo puro: sin React, sin red, sin reloj. */

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe("fmtGB", () => {
  it("por debajo de 1 GB va en MB", () => {
    expect(fmtGB(0)).toBe("0 MB");
    expect(fmtGB(500 * MB)).toBe("500 MB");
  });

  it("en MB lleva un decimal solo por debajo de 10", () => {
    expect(fmtGB(1.5 * MB)).toBe("1,5 MB");
    expect(fmtGB(9.94 * MB)).toBe("9,9 MB");
    expect(fmtGB(10 * MB)).toBe("10 MB");
    expect(fmtGB(999 * MB)).toBe("999 MB");
  });

  it("en GB lleva un decimal por debajo de 100", () => {
    expect(fmtGB(1 * GB)).toBe("1 GB");
    expect(fmtGB(2.5 * GB)).toBe("2,5 GB");
    expect(fmtGB(99.4 * GB)).toBe("99,4 GB");
    expect(fmtGB(100 * GB)).toBe("100 GB");
  });

  /* es-ES no separa los numeros de cuatro cifras (minimumGroupingDigits: 2),
     que es lo que pide la RAE; a partir de cinco si. */
  it("agrupa los miles a partir de cinco cifras", () => {
    expect(fmtGB(1234 * GB)).toBe("1234 GB");
    expect(fmtGB(12345 * GB)).toBe("12.345 GB");
  });
});

describe("quotaView", () => {
  it("sin cuota no pinta nada", () => {
    expect(quotaView(null)).toBeNull();
    expect(quotaView(undefined)).toBeNull();
  });

  it("sin limite: una sola leyenda, sin barra", () => {
    const v = quotaView({ limit: 0, usage: 3 * GB, app: 2 * GB });
    expect(v.unlimited).toBe(true);
    expect(v.legend).toBe("Espacio sin límite · Spitifo ocupa 2 GB");
    expect(v.app).toBeUndefined();
  });

  it("con limite: anchos, leyenda y frase para el lector", () => {
    const v = quotaView({ limit: 10 * GB, usage: 6 * GB, app: 4 * GB });
    expect(v.unlimited).toBe(false);
    expect(v.app).toBe("40%");
    expect(v.others).toBe("20%");
    expect(v.legend).toEqual(["Spitifo 4 GB", "Otros 2 GB", "Libre 4 GB"]);
    expect(v.aria).toBe("Spitifo 4 GB, otros archivos 2 GB, libres 4 GB de 10 GB");
  });

  it("recorta los anchos al 100 % y nunca deja 'otros' negativo", () => {
    const v = quotaView({ limit: 10 * GB, usage: 25 * GB, app: 20 * GB });
    expect(v.app).toBe("100%");
    expect(v.others).toBe("50%");
    expect(v.legend[2]).toBe("Libre 0 MB");
  });

  it("un uso mayor que el limite no desborda la barra", () => {
    const v = quotaView({ limit: 1 * GB, usage: 5 * GB, app: 5 * GB });
    expect(v.app).toBe("100%");
    expect(v.others).toBe("0%");
    expect(v.legend[1]).toBe("Otros 0 MB");
  });
});

describe("connectErrorText", () => {
  it("sin error no hay texto", () => {
    expect(connectErrorText(null)).toBeNull();
    expect(connectErrorText(undefined)).toBeNull();
    expect(connectErrorText("")).toBeNull();
  });

  it("cancelar y tiempo agotado tienen su propio texto", () => {
    expect(connectErrorText("cancelled by user")).toBe("Cancelaste el inicio de sesión.");
    expect(connectErrorText("timed out")).toBe("El navegador tardó demasiado. Vuelve a intentarlo.");
  });

  it("cualquier otro error cae en el texto generico", () => {
    expect(connectErrorText("boom")).toBe("No se pudo conectar con Google Drive. Vuelve a intentarlo.");
  });
});

describe("driveSub", () => {
  const providers = (google) => [{ id: "local" }, { id: "google", ...google }];

  it("sin informacion deja el hueco vacio", () => {
    expect(driveSub(null)).toEqual({ text: " ", state: null });
  });

  it("sin configurar lo dice", () => {
    expect(driveSub({ providers: providers({ configured: false }) })).toEqual({
      text: "No disponible en esta versión",
      state: null,
    });
  });

  it("pendiente por el navegador y por Android", () => {
    const info = { providers: providers({ configured: true }) };
    expect(driveSub(info, { pending: true })).toEqual({
      text: "Esperando al navegador…",
      state: "pending",
    });
    expect(driveSub(info, { pending: true, viaAndroid: true })).toEqual({
      text: "Esperando a Google…",
      state: "pending",
    });
  });

  it("conectada lleva punto verde", () => {
    expect(driveSub({ providers: providers({ configured: true, connected: true }) })).toEqual({
      text: "Conectada",
      state: "connected",
    });
  });

  it("configurada y sin conectar invita a conectar", () => {
    expect(driveSub({ providers: providers({ configured: true, connected: false }) })).toEqual({
      text: "Conecta tu cuenta",
      state: null,
    });
  });
});

describe("cookieStatus", () => {
  const fmt = (iso) => (iso ? "3 de noviembre de 2026" : null);

  it("mientras no hay datos esta comprobando", () => {
    expect(cookieStatus(null, fmt)).toBe("Comprobando…");
  });

  it("sin configurar", () => {
    expect(cookieStatus({ configured: false, count: 0 }, fmt)).toBe("Sin configurar");
  });

  it("una cookie en singular, varias en plural", () => {
    expect(cookieStatus({ configured: true, count: 1, imported_at: "2026-11-03" }, fmt)).toBe(
      "Configuradas · 1 cookie · 3 de noviembre de 2026"
    );
    expect(cookieStatus({ configured: true, count: 14, imported_at: "2026-11-03" }, fmt)).toBe(
      "Configuradas · 14 cookies · 3 de noviembre de 2026"
    );
  });

  it("sin fecha valida no deja un separador colgando", () => {
    expect(cookieStatus({ configured: true, count: 3, imported_at: null }, fmt)).toBe(
      "Configuradas · 3 cookies"
    );
  });
});
