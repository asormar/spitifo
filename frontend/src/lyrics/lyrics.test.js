import { describe, expect, it } from "vitest";
import { STATES, activeLine, formatTime, lyricsState, lyricsUrl, previewLine } from "./lyrics.js";

const track = {
  title: "Despechá",
  artist: "ROSALÍA",
  album: "Motomami",
  duration: 148,
  result: { duration_s: 148, extra: { aliases: { title: "デスペチャ", artist: "ロサリア" } } },
};

describe("URL del endpoint", () => {
  it("manda título, artista, álbum y duración", () => {
    const url = new URL(lyricsUrl(track), "http://local");
    expect(url.pathname).toBe("/api/lyrics");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      title: "Despechá", artist: "ROSALÍA", album: "Motomami", duration: "148",
    });
  });

  it("los alias japoneses viajan como alt_title y alt_artist", () => {
    const params = new URL(lyricsUrl(track), "http://local").searchParams;
    expect(params.getAll("alt_title")).toEqual(["デスペチャ"]);
    expect(params.getAll("alt_artist")).toEqual(["ロサリア"]);
  });

  it("sin alias no añade parámetros falsos", () => {
    const params = new URL(lyricsUrl({ title: "X", artist: "Y" }), "http://local").searchParams;
    expect(params.has("alt_title")).toBe(false);
    expect(params.has("duration")).toBe(false);
  });
});

describe("estados", () => {
  it("sin respuesta es cargando", () => {
    expect(lyricsState(null)).toBe(STATES.LOADING);
  });

  it("el error de red manda antes que cualquier otro dato", () => {
    expect(lyricsState({ error: "unavailable", synced: [{ t: 0, line: "x" }] })).toBe(STATES.UNAVAILABLE);
  });

  it("sincronizada, plana, instrumental y vacía", () => {
    expect(lyricsState({ synced: [{ t: 1, line: "a" }] })).toBe(STATES.SYNCED);
    expect(lyricsState({ synced: null, plain: "a\nb" })).toBe(STATES.PLAIN);
    expect(lyricsState({ instrumental: true })).toBe(STATES.INSTRUMENTAL);
    expect(lyricsState({ synced: null, plain: null, instrumental: false, source: null })).toBe(STATES.NONE);
    expect(lyricsState({ plain: "   " })).toBe(STATES.NONE);
  });
});

describe("línea activa y vista previa", () => {
  const lines = [{ t: 0, line: "uno" }, { t: 7, line: "dos" }, { t: 14, line: "tres" }];

  it("sigue el tiempo y salta a la línea tocada", () => {
    expect(activeLine(lines, 0)).toBe(0);
    expect(activeLine(lines, 6.9)).toBe(0);
    expect(activeLine(lines, 7)).toBe(1);
    expect(activeLine(lines, 99)).toBe(2);
    expect(activeLine([], 5)).toBe(-1);
  });

  it("la tarjeta muestra la línea que suena o el primer verso plano", () => {
    expect(previewLine({ synced: lines }, 8)).toBe("dos");
    expect(previewLine({ plain: "\nprimer verso\nsegundo" }, 8)).toBe("primer verso");
    expect(previewLine({ instrumental: true }, 8)).toBe("");
  });

  it("el reloj de la letra habla en minutos y segundos", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(38.4)).toBe("0:38");
    expect(formatTime(148)).toBe("2:28");
    expect(formatTime(-2)).toBe("0:00");
  });
});
