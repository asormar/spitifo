import { describe, expect, it } from "vitest";
import { detailMeta, detailOf } from "./detail.js";
import { albumTone, buildIndex, toneOf } from "./home.js";
import { normalizeEntry } from "./library.js";

const file = (key, folder, album, extra = {}) =>
  normalizeEntry({
    key,
    filename: `${key}.mp3`,
    folder,
    bytes: 1,
    size_mb: 1,
    duration_s: 120,
    modified: 1,
    kind: "audio",
    thumb_key: null,
    has_audio: true,
    album,
    ...extra,
  });

const entries = [
  file("a2", "Rosalía", "El mal querer", { track: 2, title: "Pienso" }),
  file("a1", "Rosalía", "El mal querer", { track: 1, title: "Malamente" }),
  file("b1", "Rosalía", "Motomami", { track: 1, title: "Saoko" }),
  file("c1", "Zoé", null, { title: "Vía Láctea" }),
];
const index = buildIndex(entries);
const byKey = new Map(entries.map((e) => [e.key, e]));
const env = (extra = {}) => ({ index, byKey, lists: [], listsReady: true, listsError: false, ...extra });
const list = (keys, id = "p1", name = "Cocina") => ({ id, name, keys });
const albumView = (name) => ({ type: "album", id: index.albums.find((g) => g.name === name).id });
const artistView = (name) => ({ type: "artist", id: index.artists.find((g) => g.name === name).id });

describe("detailOf an album", () => {
  it("orders the rows by track and knows its artist page", () => {
    const d = detailOf(albumView("El mal querer"), env());
    expect(d.state).toBe("ok");
    expect(d.rows.map((e) => e.key)).toEqual(["a1", "a2"]);
    expect(d.artist).toBe("Rosalía");
    expect(d.artistId).toBe(index.artists.find((g) => g.name === "Rosalía").id);
    expect(d.tone).toBe(albumTone("Rosalía", "El mal querer"));
  });

  it("is missing when the album left the library", () => {
    expect(detailOf({ type: "album", id: "album:nadie|nada" }, env()).state).toBe("missing");
  });
});

describe("detailOf an artist", () => {
  it("lists the songs A to Z and groups the albums", () => {
    const d = detailOf(artistView("Rosalía"), env());
    expect(d.rows.map((e) => e.title)).toEqual(["Malamente", "Pienso", "Saoko"]);
    expect(d.albums.map((g) => g.name)).toEqual(["El mal querer", "Motomami"]);
    expect(d.tone).toBe(toneOf("Rosalía"));
  });

  it("has no albums for an artist without them", () => {
    const d = detailOf(artistView("Zoé"), env());
    expect(d.albums).toEqual([]);
    expect(d.rows).toHaveLength(1);
  });
});

describe("detailOf a list", () => {
  it("keeps the order of the list and drops the keys gone from the library", () => {
    const pl = list(["c1", "gone", "a1"]);
    const d = detailOf({ type: "list", id: "p1" }, env({ lists: [pl] }));
    expect(d.rows.map((e) => e.key)).toEqual(["c1", "a1"]);
    expect(d.pl).toBe(pl);
    expect(d.gone).toBe(false);
  });

  it("takes the tone of the first song, or of the name when it is empty", () => {
    const some = detailOf({ type: "list", id: "p1" }, env({ lists: [list(["a1"])] }));
    expect(some.tone).toBe(albumTone("Rosalía", "El mal querer"));
    const none = detailOf({ type: "list", id: "p1" }, env({ lists: [list([])] }));
    expect(none.tone).toBe(toneOf("Cocina"));
  });

  it("tells an empty list from one whose songs are all gone", () => {
    expect(detailOf({ type: "list", id: "p1" }, env({ lists: [list([])] })).gone).toBe(false);
    const all = detailOf({ type: "list", id: "p1" }, env({ lists: [list(["x", "y"])] }));
    expect(all.state).toBe("ok");
    expect(all.rows).toEqual([]);
    expect(all.gone).toBe(true);
  });

  it("is loading, failed or missing while the lists are not there", () => {
    const view = { type: "list", id: "p9" };
    expect(detailOf(view, env({ listsReady: false })).state).toBe("loading");
    expect(detailOf(view, env({ listsReady: false, listsError: true })).state).toBe("error");
    expect(detailOf(view, env({ lists: [list([])] })).state).toBe("missing");
  });
});

describe("detailMeta", () => {
  it("writes the list meta with songs and minutes, and skips minutes without durations", () => {
    const d = detailOf({ type: "list", id: "p1" }, env({ lists: [list(["a1", "a2", "c1"])] }));
    expect(detailMeta(d, "Google Drive")).toEqual({ meta: "Lista · 3 canciones · 6 min" });
    const lone = { ...d, rows: d.rows.slice(0, 1), mins: null };
    expect(detailMeta(lone, "x")).toEqual({ meta: "Lista · 1 canción" });
  });

  it("writes the album liner with where it is stored", () => {
    const d = detailOf(albumView("El mal querer"), env());
    expect(detailMeta(d, "Google Drive").liner).toEqual(["2 canciones · 4 min", "En Google Drive"]);
    expect(detailMeta(d, "este dispositivo").liner[1]).toBe("En este dispositivo");
    expect(detailMeta({ ...d, mins: null }, "x").liner[0]).toBe("2 canciones");
  });

  it("writes the artist meta with the plural of albums", () => {
    const rosalia = detailOf(artistView("Rosalía"), env());
    expect(detailMeta(rosalia, "x")).toEqual({ meta: "2 álbumes · 3 canciones" });
    const one = { ...rosalia, albums: rosalia.albums.slice(0, 1) };
    expect(detailMeta(one, "x").meta).toBe("1 álbum · 3 canciones");
  });
});
