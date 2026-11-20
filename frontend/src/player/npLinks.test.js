import { describe, expect, it } from "vitest";
import { npLinks } from "./npLinks.js";

const entry = { key: "A/x.mp3", artist: "Foo Fighters", album: "The Colour And The Shape", title: "Everlong" };

describe("npLinks", () => {
  it("una cancion de la biblioteca va a sus paginas de Escuchar", () => {
    const l = npLinks({ key: entry.key, kind: "library" }, entry);
    expect(l.artist).toEqual({ name: "Foo Fighters", tab: "library", view: { type: "artist", id: "artist:foo fighters" } });
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
    expect(l.artist).toEqual({
      name: "Kevin MacLeod", tab: "search", view: { type: "itunesartist", id: 204264696, name: "Kevin MacLeod" },
    });
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

  it("un artista desconocido o «varios» no lleva a ningun lado", () => {
    expect(npLinks({ result: { artist: "varios" } }, null).artist).toBeNull();
    expect(npLinks({}, { ...entry, artist: "Artista desconocido" }).artist).toBeNull();
  });

  it("un avance sin resultado guardado no tiene enlaces", () => {
    expect(npLinks({ kind: "preview" }, null)).toEqual({ artist: null, album: null });
  });
});
