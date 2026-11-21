import { describe, expect, it } from "vitest";
import { bestResultSong } from "./bestResultSong.js";

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
