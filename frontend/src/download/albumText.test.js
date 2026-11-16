import { describe, expect, it } from "vitest";
import { albumButton, groupToast, missingSentence } from "./albumText.js";

describe("albumButton", () => {
  it("muestra busqueda mientras empareja", () => {
    expect(albumButton({ matching: true, full: 9 })).toEqual({
      text: "Buscando versiones…",
      disabled: true,
    });
  });

  it("anuncia el total antes de bajar nada", () => {
    expect(albumButton({ matching: false, full: 9 })).toEqual({
      text: "Descargar álbum · 9 canciones",
      disabled: false,
    });
    expect(albumButton({ matching: false, full: 1 }).text).toBe("Descargar álbum · 1 canción");
  });

  it("cuenta lo que queda tras una descarga parcial", () => {
    expect(albumButton({ matching: false, full: 9, done: 7 }).text).toBe("Descargar las 2 que faltan");
  });

  it("muestra progreso y cierre segun el estado de la cola", () => {
    expect(albumButton({ matching: false, full: 9, done: 3, running: true })).toEqual({
      text: "Descargando · 3 de 9",
      disabled: true,
    });
    expect(albumButton({ matching: false, full: 9, done: 9 })).toEqual({
      text: "Álbum descargado",
      disabled: true,
    });
  });
});

describe("missingSentence", () => {
  it("no dice nada si todas tienen version completa", () => {
    expect(missingSentence([])).toBe("");
  });

  it("nombra una, dos y tres con la conjunción correcta", () => {
    expect(missingSentence(["Hombre al agua"])).toBe(
      "«Hombre al agua» no tiene versión completa: solo se puede escuchar 30 s."
    );
    expect(missingSentence(["A", "B"])).toBe(
      "«A» y «B» no tienen versión completa: solo se pueden escuchar 30 s."
    );
    expect(missingSentence(["A", "B", "C"])).toBe(
      "«A», «B» y «C» no tienen versión completa: solo se pueden escuchar 30 s."
    );
  });

  it("corta a tres y dice cuantos faltan", () => {
    expect(missingSentence(["A", "B", "C", "D", "E"])).toBe(
      "«A», «B» y «C» y 2 más no tienen versión completa: solo se pueden escuchar 30 s."
    );
  });
});

describe("groupToast", () => {
  it("resume un grupo completo", () => {
    expect(groupToast("Canción animal", { done: 9, total: 9, failed: 0 })).toBe(
      "Canción animal: 9 descargadas"
    );
  });

  it("dice cuantas fallaron", () => {
    expect(groupToast("Canción animal", { done: 8, total: 9, failed: 1 })).toBe(
      "Canción animal: 8 de 9, 1 falló"
    );
  });
});
