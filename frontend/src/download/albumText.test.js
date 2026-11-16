import { describe, expect, it } from "vitest";
import { albumButton, groupToast, missingSentence, ownedSlots, trackSlot } from "./albumText.js";

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

describe("ownedSlots", () => {
  it("collects the disc and track of the library entries of this album only", () => {
    const entries = [
      { album_id: "321882757", disc_no: 1, track_no: 3 },
      { album_id: "321882757", disc_no: null, track_no: 9 },
      { album_id: "999", disc_no: 1, track_no: 4 },
      { album_id: "321882757", disc_no: 1, track_no: null },
      { album_id: null, disc_no: 1, track_no: 5 },
    ];
    expect([...ownedSlots(entries, 321882757)].sort()).toEqual(["1-3", "1-9"]);
    expect(ownedSlots(entries, null).size).toBe(0);
  });

  it("matches the slot of an iTunes track", () => {
    expect(trackSlot(1, 9)).toBe("1-9");
    expect(trackSlot(undefined, 2)).toBe("1-2");
    expect(trackSlot(1, null)).toBe(null);
  });
});

describe("albumButton with owned tracks", () => {
  it("says the album is already there when nothing is left to download", () => {
    expect(albumButton({ matching: false, full: 0, owned: 9 })).toEqual({ text: "Ya está en tu biblioteca", disabled: true });
    expect(albumButton({ matching: false, full: 0 })).toEqual({ text: "Sin versiones completas", disabled: true });
    expect(albumButton({ matching: false, full: 1, owned: 9 }).text).toBe("Descargar la que falta");
    expect(albumButton({ matching: false, full: 3, owned: 7 }).text).toBe("Descargar las 3 que faltan");
  });
});
