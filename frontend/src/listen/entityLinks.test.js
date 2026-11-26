import { describe, expect, it } from "vitest";
import { albumId, artistId } from "./library.js";
import { albumView, artistView, relatedArtists } from "./entityLinks.js";

describe("un destino por entidad", () => {
  const entries = [
    { artist: "ROSALÍA", album: "Motomami" },
    { artist: "Rosalía", album: "El mal querer" },
  ];

  it("el artista resuelve siempre al id del indice, sin importar mayusculas", () => {
    const a = artistView("ROSALÍA", entries);
    const b = artistView("rosalia", entries);
    expect(a.id).toBe(artistId({ artist: "ROSALÍA" }));
    expect(b.id).toBe(a.id);
    expect(a.name).toBe("ROSALÍA");
  });

  it("un artista que no esta en la biblioteca no tiene pagina local", () => {
    expect(artistView("Soda Stereo", entries)).toBeNull();
    expect(artistView("", entries)).toBeNull();
  });

  it("el album lleva el id compuesto de artista y titulo", () => {
    expect(albumView("ROSALÍA", "Motomami")).toEqual({
      type: "album",
      id: albumId({ artist: "ROSALÍA", album: "Motomami" }),
      name: "Motomami",
      artist: "ROSALÍA",
    });
    expect(albumView("ROSALÍA", "")).toBeNull();
  });

  it("los similares salen de recomendaciones, sin repetir el artista", () => {
    const out = relatedArtists(
      "ROSALÍA",
      [
        { name: "Rosalía", score: 99 },
        { name: "ADOY", score: 3, genres: ["indie"], because: ["Suena parecido"] },
        { name: "LACO", score: 2, genres: ["indie"] },
        { name: "Otro", score: 0 },
      ],
      2
    );
    expect(out.map((a) => a.name)).toEqual(["ADOY", "LACO"]);
    expect(out[0].because).toEqual(["Suena parecido"]);
  });
});
