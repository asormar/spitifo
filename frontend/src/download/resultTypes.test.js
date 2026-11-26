import { describe, expect, it } from "vitest";
import {
  SOURCE_CHIPS, TYPE_CHIPS, countKind, countSource, entriesFor, filterEntries, sourceLegend, sourceName,
} from "./resultTypes.js";

const entries = () => entriesFor({
  results: [
    { source: "itunes", title: "Cancion" },
    { source: "ytdlp", title: "Video", extra: { is_live: true } },
  ],
  albums: [{ id: 1, title: "Disco" }],
  artists: [{ id: 2, name: "Artista" }],
});

describe("resultTypes", () => {
  it("junta los tres tipos de entrada y les da una fuente", () => {
    expect(entries().map((e) => e.kind)).toEqual(["song", "live", "album", "artist"]);
    expect(entries()[1].source).toBe("ytdlp");
    expect(entries()[2].source).toBe("itunes");
  });

  it("cuenta por tipo y por fuente", () => {
    expect(countKind(entries(), "all")).toBe(4);
    expect(countKind(entries(), "live")).toBe(1);
    expect(countSource(entries(), "itunes")).toBe(3);
    expect(countSource(entries(), "ytdlp")).toBe(1);
  });

  it("combina ambos filtros", () => {
    expect(filterEntries(entries(), { type: "live", source: "ytdlp" })).toHaveLength(1);
    expect(filterEntries(entries(), { type: "live", source: "itunes" })).toHaveLength(0);
    expect(filterEntries(entries(), { type: "all", source: "all" })).toHaveLength(4);
  });

  it("explica las cinco siglas junto a los chips", () => {
    expect(TYPE_CHIPS).toHaveLength(5);
    expect(SOURCE_CHIPS.map((s) => s.code)).toEqual(["iT", "IA", "J", "W", "YT"]);
    expect(sourceLegend()).toEqual(SOURCE_CHIPS.map(({ code, label }) => ({ code, label })));
    expect(sourceName("YT")).toBe("YouTube");
  });
});
