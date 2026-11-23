import { describe, expect, it } from "vitest";
import { rowChip, rowPlayPlan } from "./rowPlayPlan.js";

describe("rowPlayPlan", () => {
  it("reproduce en streaming una pista de YouTube con version completa", () => {
    expect(rowPlayPlan({
      source: "itunes",
      extra: { webpage_url: "https://www.youtube.com/watch?v=abcdefghijk" },
    })).toBe("stream");
  });

  it("un resultado de YouTube con webpage_url tambien es streaming", () => {
    expect(rowPlayPlan({
      source: "ytdlp",
      source_id: "abcdefghijk",
      extra: { webpage_url: "https://youtu.be/abcdefghijk" },
    })).toBe("stream");
  });

  it("escucha directo un resultado de Internet Archive con audio", () => {
    expect(rowPlayPlan({
      source: "archive",
      source_id: "items/xyz",
      audio_url: "https://archive.org/download/a/b.mp3",
      extra: {},
    })).toBe("archive");
    expect(rowPlayPlan({
      source: "archive",
      source_id: "items/xyz",
      extra: { needs_resolve: true },
    })).toBe("archive");
  });

  it("resuelve antes de sonar un resultado de iTunes pendiente", () => {
    expect(rowPlayPlan({
      source: "itunes",
      source_id: "123",
      extra: { needs_resolve: true },
    })).toBe("resolve");
    expect(rowPlayPlan({
      source: "itunes",
      source_id: "123",
      extra: { needs_resolve: true },
      preview_url: "https://audio-ssl.itunes.apple.com/preview.m4a",
    })).toBe("resolve");
  });

  it("cae al avance de 30 s cuando solo hay preview", () => {
    expect(rowPlayPlan({
      source: "itunes",
      source_id: "123",
      preview_url: "https://audio-ssl.itunes.apple.com/preview.m4a",
      extra: {},
    })).toBe("preview");
  });

  it("no planea nada sin fuente reproducible", () => {
    expect(rowPlayPlan(null)).toBeNull();
    expect(rowPlayPlan({ source: "itunes", source_id: "123", extra: {} })).toBeNull();
    /* YouTube sin webpage_url: el backend no tiene nada que resolver. */
    expect(rowPlayPlan({ source: "ytdlp", source_id: "abcdefghijk", extra: {} })).toBeNull();
  });

  it("una fila de una ola todavia sin video usa el match con prioridad", () => {
    for (const match_state of ["pending", "lazy"]) {
      expect(rowPlayPlan({
        source: "itunes",
        source_id: "123",
        preview_url: "https://audio-ssl.itunes.apple.com/preview.m4a",
        extra: { match_state },
      })).toBe("eager");
    }
  });

  it("un match de iTunes ya resuelto con webpage_url suena completo", () => {
    expect(rowPlayPlan({
      source: "itunes",
      source_id: "123",
      extra: { needs_resolve: false, webpage_url: "https://www.youtube.com/watch?v=abcdefghijk" },
    })).toBe("stream");
  });
});

describe("rowChip", () => {
  const ola = (match_state) => ({ source: "itunes", source_id: "1", preview_url: "https://a/p.m4a", extra: { match_state } });

  it("«Buscando» solo en las filas que el servidor busca ahora", () => {
    expect(rowChip(ola("pending"))).toBe("seek");
  });

  it("una fila lazy no lleva pastilla: espera a verse callada", () => {
    expect(rowPlayPlan(ola("lazy"))).toBe("eager");
    expect(rowChip(ola("lazy"))).toBeNull();
  });

  it("sin video queda el «30 s»; con video, nada", () => {
    expect(rowChip(ola("none"))).toBe("30");
    expect(rowChip({ source: "itunes", extra: { match_state: "full", webpage_url: "https://www.youtube.com/watch?v=abcdefghijk" } })).toBeNull();
  });
});
