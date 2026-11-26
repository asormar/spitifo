import { describe, expect, it } from "vitest";
import { COMPACT_FIELDS, compactLibraryRows, expandCompactLibrary } from "./libraryCompact.js";

const FILE = {
  key: "A/A - x.mp3", filename: "A - x.mp3", folder: "A", bytes: 1048576,
  duration_s: 180, title: "x", artist: "A", album: "Disco", track_no: 1,
  disc_no: 1, album_id: "123", modified: 100, kind: "audio",
  thumb_key: "A/A - x.jpg", has_audio: true, thumb_s: true, verdict: "match",
  meta_src: "itunes", file_src: null, real: null, size_mb: 1,
};

describe("expandCompactLibrary", () => {
  it("vuelve a armar el objeto de siempre a partir de columnas", () => {
    const rows = compactLibraryRows([FILE]);
    const [out] = expandCompactLibrary(COMPACT_FIELDS, rows);
    for (const key of COMPACT_FIELDS) expect(out[key]).toEqual(FILE[key]);
  });

  it("recalcula size_mb de bytes: no viaja en la forma compacta", () => {
    const rows = compactLibraryRows([FILE]);
    const [out] = expandCompactLibrary(COMPACT_FIELDS, rows);
    expect(out.size_mb).toBe(1);
  });

  it("un campo ausente en la fila (undefined) expande a null", () => {
    const [out] = expandCompactLibrary(["key", "title"], [["A/x.mp3"]]);
    expect(out.key).toBe("A/x.mp3");
    expect(out.title).toBeNull();
  });

  it("sin fields (backend viejo que no los mando) cae a COMPACT_FIELDS", () => {
    const rows = compactLibraryRows([FILE]);
    const [out] = expandCompactLibrary(null, rows);
    expect(out.key).toBe(FILE.key);
    expect(out.artist).toBe(FILE.artist);
  });

  it("lista vacia o ausente no rompe", () => {
    expect(expandCompactLibrary(COMPACT_FIELDS, [])).toEqual([]);
    expect(expandCompactLibrary(COMPACT_FIELDS, null)).toEqual([]);
  });
});

describe("compactLibraryRows", () => {
  it("un campo sin valor en el archivo compacta a null, no a undefined", () => {
    const [row] = compactLibraryRows([{ key: "A/x.mp3" }], ["key", "artist"]);
    expect(row).toEqual(["A/x.mp3", null]);
  });

  it("ida y vuelta: expandir lo que compacto da el mismo archivo", () => {
    const rows = compactLibraryRows([FILE]);
    const [out] = expandCompactLibrary(COMPACT_FIELDS, rows);
    expect(out).toEqual(FILE);
  });
});
