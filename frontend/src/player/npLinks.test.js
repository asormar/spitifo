import { describe, expect, it } from "vitest";
import { npLinks, splitArtistCredit } from "./npLinks.js";

const entry = { key: "A/x.mp3", artist: "Foo Fighters", album: "The Colour And The Shape", title: "Everlong" };
const itunes = (name, id) => ({ name, tab: "search", view: { type: "itunesartist", id, name } });
const part = (name, sep, link) => ({ name, sep, link });

describe("npLinks", () => {
  it("una cancion de la biblioteca con id de iTunes abre el artista general", () => {
    const l = npLinks({ key: entry.key, kind: "library" }, { ...entry, artist_id: 321 });
    expect(l.artist).toEqual(itunes("Foo Fighters", 321));
    expect(l.artists).toEqual([part("Foo Fighters", "", itunes("Foo Fighters", 321))]);
  });

  it("una cancion de la biblioteca sin id se resuelve por nombre", () => {
    const l = npLinks({ key: entry.key, kind: "library" }, entry);
    expect(l.artist).toEqual({ name: "Foo Fighters", resolve: true });
    expect(l.artists).toEqual([part("Foo Fighters", "", { name: "Foo Fighters", resolve: true })]);
  });

  it("el album de la biblioteca sigue llevando a Escuchar", () => {
    const l = npLinks({ key: entry.key, kind: "library" }, { ...entry, artist_id: 321 });
    expect(l.album).toEqual({
      name: "The Colour And The Shape",
      tab: "library",
      view: { type: "album", id: "album:foo fighters|the colour and the shape" },
    });
  });

  it("sin album no hay enlace de album", () => {
    expect(npLinks({}, { ...entry, album: "" }).album).toBeNull();
  });

  it("un streaming con ids de iTunes abre el artista y la ficha del disco", () => {
    const result = {
      artist: "Kevin MacLeod", album: "Monkeys - Single", year: "2019", artwork_url: "a.jpg",
      extra: { artist_id: 204264696, collection_id: 1667933650, track_count: 1 },
    };
    const l = npLinks({ kind: "stream", result }, null);
    expect(l.artist).toEqual(itunes("Kevin MacLeod", 204264696));
    expect(l.album.sheet).toEqual({
      type: "albumsheet",
      id: "1667933650",
      from: "listen",
      album: { id: 1667933650, title: "Monkeys - Single", artist: "Kevin MacLeod", year: "2019", track_count: 1, artwork_url: "a.jpg" },
    });
  });

  it("sin id de artista se resuelve por nombre; sin id de disco no hay ficha", () => {
    const l = npLinks({ kind: "stream", result: { artist: "Grateful Dead", album: "Live", extra: {} } }, null);
    expect(l.artist).toEqual({ name: "Grateful Dead", resolve: true });
    expect(l.album).toBeNull();
  });

  it("un credito con varios artistas parte cada nombre y conserva los separadores", () => {
    const result = {
      artist: "Satsuki, Hatsune Miku & Kasane Teto",
      extra: { artist_id: 204264696 },
    };
    const l = npLinks({ kind: "stream", result }, null);
    expect(l.artists).toEqual([
      part("Satsuki", "", itunes("Satsuki", 204264696)),
      part("Hatsune Miku", ", ", { name: "Hatsune Miku", resolve: true }),
      part("Kasane Teto", " & ", { name: "Kasane Teto", resolve: true }),
    ]);
    expect(l.artist).toEqual(l.artists[0].link);
    expect(l.artists.map((p) => p.sep + p.name).join("")).toBe("Satsuki, Hatsune Miku & Kasane Teto");
  });

  it("las palabras separadoras (feat, y) tambien conservan su texto", () => {
    expect(splitArtistCredit("Satsuki feat. Hatsune Miku y Kasane Teto")).toEqual([
      { name: "Satsuki", sep: "" },
      { name: "Hatsune Miku", sep: " feat. " },
      { name: "Kasane Teto", sep: " y " },
    ]);
  });

  it("Malcolm X no se parte por la x", () => {
    expect(splitArtistCredit("Malcolm X")).toEqual([{ name: "Malcolm X", sep: "" }]);
    const l = npLinks({ result: { artist: "Malcolm X", extra: { artist_id: 5 } } }, null);
    expect(l.artists).toEqual([part("Malcolm X", "", itunes("Malcolm X", 5))]);
  });

  it("las partes repetidas se descartan", () => {
    expect(splitArtistCredit("Soda Stereo, Soda Stereo")).toEqual([{ name: "Soda Stereo", sep: "" }]);
  });

  it("un artista suelto mantiene un solo enlace", () => {
    const l = npLinks({ kind: "stream", result: { artist: "Grateful Dead", extra: {} } }, null);
    expect(l.artists).toEqual([part("Grateful Dead", "", { name: "Grateful Dead", resolve: true })]);
    expect(l.artist).toEqual(l.artists[0].link);
  });

  it("un artista desconocido o «varios» no lleva a ningun lado", () => {
    expect(npLinks({ result: { artist: "varios" } }, null).artist).toBeNull();
    expect(npLinks({ result: { artist: "varios" } }, null).artists[0].link).toBeNull();
    expect(npLinks({}, { ...entry, artist: "Artista desconocido" }).artist).toBeNull();
  });

  it("un avance sin resultado guardado no tiene enlaces", () => {
    expect(npLinks({ kind: "preview" }, null)).toEqual({ artist: null, artists: [], album: null });
  });
});
