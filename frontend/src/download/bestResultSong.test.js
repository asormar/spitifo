import { describe, expect, it } from "vitest";
import { bestResultSong, popularSongs } from "./bestResultSong.js";

const song = (title, artist, extra = {}) => ({
  source: "itunes",
  source_id: title,
  title,
  artist,
  preview_url: "https://x/preview.m4a",
  extra,
});

describe("bestResultSong", () => {
  it("toma la primera cancion del artista que se pueda tocar", () => {
    const results = [
      song("Everlong", "Foo Fighters"),
      { ...song("Let Down", "Radiohead"), preview_url: null },
      song("Creep", "RADIOHEAD"),
      song("Karma Police", "radiohead"),
    ];
    expect(bestResultSong(results, { name: "Radiohead" })?.title).toBe("Creep");
  });

  it("ignora tildes, mayusculas y el articulo inicial", () => {
    const results = [song("De Música Ligera", "Los Soda Stereo")];
    expect(bestResultSong(results, { name: "Sódá Stereo" })?.title).toBe("De Música Ligera");
    expect(bestResultSong(results, { name: "Nirvana" })).toBe(null);
  });

  it("no devuelve nada si la tarjeta no es un artista o no hay coincidencia", () => {
    expect(bestResultSong([song("Creep", "Radiohead")], null)).toBe(null);
    expect(bestResultSong([song("Creep", "Radiohead")], {})).toBe(null);
    expect(bestResultSong([song("Creep", "Radiohead")], { name: "Nirvana" })).toBe(null);
    expect(bestResultSong(undefined, { name: "Radiohead" })).toBe(null);
  });
});

describe("popularSongs", () => {
  const results = [
    song("Creep", "RADIOHEAD"),
    song("Everlong", "Foo Fighters"),
    song("Karma Police", "radiohead"),
    { ...song("Let Down", "Radiohead"), preview_url: null },
    song("No Surprises", "the Radiohead"),
    song("Lift", "Radiohead"),
  ];

  it("toma hasta cinco del artista, en orden y solo las que suenan", () => {
    expect(popularSongs(null, results, "Radiohead").map((t) => t.title)).toEqual([
      "Creep", "Karma Police", "No Surprises", "Lift",
    ]);
  });

  it("prefiere las destacadas del payload cuando las trae", () => {
    const data = { top_songs: [song("Creep", "Radiohead")] };
    expect(popularSongs(data, results, "Radiohead").map((t) => t.title)).toEqual(["Creep"]);
  });

  it("no inventa populares sin nombre, sin resultados o sin coincidencias", () => {
    expect(popularSongs(null, results, null)).toEqual([]);
    expect(popularSongs(null, undefined, "Radiohead")).toEqual([]);
    expect(popularSongs(null, [song("Everlong", "Foo Fighters")], "Radiohead")).toEqual([]);
  });

  it("respeta el limite", () => {
    expect(popularSongs(null, results, "Radiohead", undefined, 2).map((t) => t.title)).toEqual([
      "Creep", "Karma Police",
    ]);
  });
});
