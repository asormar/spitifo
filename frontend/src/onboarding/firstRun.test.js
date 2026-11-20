import { describe, expect, it } from "vitest";
import { FALLBACK_FOLDER, folderLabel, shouldShowFirstRun } from "./firstRun.js";

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

describe("folderLabel", () => {
  it("names the phone folder the way the file manager shows it", () => {
    expect(folderLabel("/storage/emulated/0/Music/Spitifo")).toBe("la carpeta Música › Spitifo");
  });

  it("drops the Windows user folder", () => {
    expect(folderLabel(String.raw`C:\Users\Ana\Music\Spitifo`)).toBe("la carpeta Música › Spitifo");
    expect(folderLabel(String.raw`C:\Users\Ana\Music\Spitifo\ `.trim())).toBe("la carpeta Música › Spitifo");
  });

  it("keeps the last two folders of a path outside the user folder", () => {
    expect(folderLabel(String.raw`D:\Musica\Spitifo`)).toBe("la carpeta Musica › Spitifo");
  });

  it("falls back when there is no path", () => {
    expect(folderLabel("")).toBe(FALLBACK_FOLDER);
    expect(folderLabel(null)).toBe(FALLBACK_FOLDER);
  });
});
