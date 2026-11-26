import { describe, expect, it } from "vitest";
import {
  importSummary,
  matchTracks,
  parseCsv,
  parseImport,
  parseM3u,
  parseSpotifyCsv,
} from "./playlistImport.js";

describe("CSV exportado", () => {
  it("lee titulo, artista y album de Exportify", () => {
    const csv = [
      "track_name,artist_name,album_name,track_uri",
      "Mesmerizer,Satsuki, Mesmerizer,spotify:track:1",
      "LA FAMA,\"ROSALÍA, The Weeknd\",Motomami,spotify:track:2",
    ].join("\r\n");
    expect(parseSpotifyCsv(csv)).toEqual([
      { title: "Mesmerizer", artist: "Satsuki", album: "Mesmerizer" },
      { title: "LA FAMA", artist: "ROSALÍA, The Weeknd", album: "Motomami" },
    ]);
  });

  it("respeta comillas, comas y saltos dentro de un campo", () => {
    expect(parseCsv('a,"linea\ncon coma, y todo","comilla ""doble"""'))
      .toEqual([["a", "linea\ncon coma, y todo", 'comilla "doble"']]);
  });

  it("acepta cabeceras en castellano y sin BOM", () => {
    expect(parseSpotifyCsv("\uFEFFTítulo,Intérprete,Álbum\nSol,Bad Gyal,Caliente")
      .map((t) => t.title)).toEqual(["Sol"]);
  });

  it("una exportacion vacia no inventa pistas", () => {
    expect(parseSpotifyCsv("")).toEqual([]);
    expect(parseSpotifyCsv("track_name,artist_name")).toEqual([]);
  });
});

describe("M3U", () => {
  it("lee EXTINF con artista y titulo", () => {
    const m3u = [
      "#EXTM3U",
      "#EXTINF:161,Satsuki - Mesmerizer",
      "A/Mesmerizer.mp3",
      "#EXTINF:193,ROSALÍA - Despechá",
      "A/Despechá.mp3",
    ].join("\n");
    expect(parseM3u(m3u)).toEqual([
      { title: "Mesmerizer", artist: "Satsuki", album: "" },
      { title: "Despechá", artist: "ROSALÍA", album: "" },
    ]);
  });

  it("acepta EXTART y rutas sin EXTINF", () => {
    expect(parseM3u("#EXTART:Bad Gyal\n#EXTINF:200,Un rayo de sol\nA/x.mp3"))
      .toEqual([{ title: "Un rayo de sol", artist: "Bad Gyal", album: "" }]);
    expect(parseM3u("C:\\Music\\Tema.mp3"))
      .toEqual([{ title: "Tema", artist: "", album: "" }]);
  });

  it("parseImport elige el formato", () => {
    expect(parseImport("#EXTINF:1,A - B", "m3u")[0].title).toBe("B");
    expect(parseImport("Track Name\nCancion", "csv")[0].title).toBe("Cancion");
  });
});

describe("coincidencias con la biblioteca", () => {
  const entries = [
    { key: "a", title: "Mesmerizer", artist: "Satsuki" },
    { key: "b", title: "Despechá", artist: "ROSALÍA" },
  ];

  it("encuentra las que estan y senala las que faltan", () => {
    const tracks = [
      { title: "mesmerizer", artist: "satsuki" },
      { title: "Un rayo de sol", artist: "Bad Gyal" },
      { title: "Despechá", artist: "ROSALÍA" },
    ];
    const { matches, missing } = matchTracks(tracks, entries);
    expect(matches.get(0).key).toBe("a");
    expect(matches.get(2).key).toBe("b");
    expect(missing).toEqual([1]);
    expect(importSummary(tracks, matches)).toEqual({ total: 3, found: 2, missing: 1 });
  });

  it("no cuelga una cancion con artista distinto", () => {
    const { matches, missing } = matchTracks(
      [{ title: "Despechá", artist: "Otro cantante" }], entries);
    expect(matches.size).toBe(0);
    expect(missing).toEqual([0]);
  });
});
