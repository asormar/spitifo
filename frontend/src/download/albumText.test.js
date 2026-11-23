import { describe, expect, it } from "vitest";
import {
  OFFLINE_BANNER,
  OFFLINE_PILL,
  groupToast,
  missingSentence,
  ownedSlots,
  pausedText,
  reattachText,
  resumingText,
  trackSlot,
} from "./albumText.js";

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
