import { describe, expect, it } from "vitest";
import {
  OFFLINE_BANNER,
  OFFLINE_PILL,
  albumButton,
  groupToast,
  missingSentence,
  ownedSlots,
  pausedText,
  reattachText,
  resumingText,
  trackSlot,
} from "./albumText.js";

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

describe("descargas que no se pierden", () => {
  it("el aviso de reenganche concuerda con el numero de descargas", () => {
    expect(reattachText(1)).toBe("Seguimos con la descarga que dejaste en marcha.");
    expect(reattachText(9)).toBe("Seguimos con 9 descargas que dejaste en marcha.");
  });

  it("el texto sin red dice donde quedo y desde donde se retoma", () => {
    expect(OFFLINE_BANNER).toBe("Sin conexión. Las descargas siguen solas en cuanto vuelva la red.");
    expect(OFFLINE_PILL).toBe("Sin conexión · en pausa");
    expect(pausedText(62.4)).toBe("En pausa · sin red · 62 %");
    expect(resumingText(62)).toBe("Retomando desde 62 %");
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

describe("ownedEntries", () => {
  it("maps each owned slot of the album to its library entry", async () => {
    const { ownedEntries } = await import("./albumText.js");
    const a = { key: "A/1.m4a", album_id: 999, disc_no: 1, track_no: 1 };
    const b = { key: "A/2.m4a", album_id: "999", disc_no: 1, track_no: 2 };
    const other = { key: "B/1.m4a", album_id: 5, disc_no: 1, track_no: 1 };
    const m = ownedEntries([a, b, other], 999);
    expect([...m.values()].map((e) => e.key)).toEqual(["A/1.m4a", "A/2.m4a"]);
    expect(ownedEntries([a], null).size).toBe(0);
  });
});
