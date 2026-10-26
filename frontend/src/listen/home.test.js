import { describe, expect, it } from "vitest";
import {
  albumHue,
  albumOrder,
  buildIndex,
  continueItems,
  entryHue,
  hueOf,
  minutes,
  mosaicHues,
  plural,
  queryTerms,
  recentAlbums,
  recentEntries,
  relevance,
  searchLibrary,
  sortEntries,
  topArtists,
  topItems,
} from "./home.js";
import { normalizeLibrary } from "./library.js";

const file = (key, artist, title, extra = {}) => ({
  key,
  filename: `${title}.mp3`,
  folder: artist,
  artist,
  title,
  kind: "audio",
  duration_s: 200,
  modified: 1000,
  has_audio: true,
  ...extra,
});

const LIB = normalizeLibrary([
  file("rosalia/saoko", "Rosalía", "Saoko", { album: "Motomami", modified: 10 }),
  file("rosalia/candy", "Rosalía", "Candy", { album: "Motomami", modified: 11 }),
  file("rosalia/malamente", "Rosalía", "Malamente", { album: "El mal querer", modified: 5 }),
  file("soda/musica", "Soda Stereo", "De música ligera", { album: "Canción animal", modified: 30 }),
  file("soda/signos", "Soda Stereo", "Signos", { album: "Signos", modified: 20 }),
  file("bb/titi", "Bad Bunny", "Tití me preguntó", { album: "Un verano sin ti", modified: 40 }),
  file("zoe/azul", "Zoé", "Azul", { modified: 2 }),
  file("zoe/video", "Zoé", "Azul en vivo", { kind: "video", modified: 50 }),
]);
const byKey = new Map(LIB.map((e) => [e.key, e]));
const INDEX = buildIndex(LIB);

describe("relevance", () => {
  it("ranks exact over prefix over word-prefix over contains, ignoring accents", () => {
    expect(relevance("Rosalía", "rosalia")).toBe(100);
    expect(relevance("Rosalía Vega", "rosalia")).toBe(80);
    expect(relevance("Un verano sin ti", "sin")).toBe(60);
    expect(relevance("Motomami", "tom")).toBe(40);
    expect(relevance("Motomami", "zzz")).toBe(0);
  });

  it("is 0 for an empty query or name", () => {
    expect(relevance("algo", "")).toBe(0);
    expect(relevance("", "algo")).toBe(0);
  });
});

describe("queryTerms", () => {
  it("folds, splits on whitespace and drops empties", () => {
    expect(queryTerms("  Música   LIGERA ")).toEqual(["musica", "ligera"]);
    expect(queryTerms("   ")).toEqual([]);
  });
});

describe("searchLibrary", () => {
  const lists = [
    { id: "p1", name: "Para correr", keys: ["rosalia/saoko"] },
    { id: "p2", name: "Rock en español", keys: [] },
  ];

  it("returns nothing for an empty query", () => {
    const r = searchLibrary(INDEX, "  ", { lists });
    expect(r.empty).toBe(true);
    expect(r.best).toBeNull();
    expect(r.songs).toEqual([]);
  });

  it("groups songs, artists, albums and lists, ignoring accents", () => {
    const r = searchLibrary(INDEX, "rosalia", { lists });
    expect(r.artists.map((a) => a.name)).toEqual(["Rosalía"]);
    expect(r.albums.map((a) => a.name).sort()).toEqual(["El mal querer", "Motomami"]);
    expect(r.songs.map((s) => s.key).sort()).toEqual([
      "rosalia/candy",
      "rosalia/malamente",
      "rosalia/saoko",
    ]);
    expect(r.lists).toEqual([]);
    expect(r.empty).toBe(false);
  });

  it("matches every term anywhere in title, artist or album", () => {
    const r = searchLibrary(INDEX, "motomami saoko");
    expect(r.songs.map((s) => s.key)).toEqual(["rosalia/saoko"]);
    expect(r.artists).toEqual([]);
  });

  it("finds lists by name", () => {
    const r = searchLibrary(INDEX, "correr", { lists });
    expect(r.lists.map((p) => p.id)).toEqual(["p1"]);
    expect(r.songs).toEqual([]);
    expect(r.empty).toBe(false);
  });

  it("is empty when nothing matches", () => {
    const r = searchLibrary(INDEX, "xyzzy", { lists });
    expect(r.empty).toBe(true);
    expect(r.best).toBeNull();
  });

  it("orders songs by name relevance, then by plays", () => {
    const r = searchLibrary(INDEX, "signos", { plays: {} });
    expect(r.songs[0].key).toBe("soda/signos");

    const tie = searchLibrary(INDEX, "azul", { plays: { "zoe/video": 9, "zoe/azul": 1 } });
    /* "Azul" es exacto (100) y "Azul en vivo" solo empieza por ella (80). */
    expect(tie.songs.map((s) => s.key)).toEqual(["zoe/azul", "zoe/video"]);

    const tie2 = searchLibrary(INDEX, "rosalia", { plays: { "rosalia/candy": 5 } });
    expect(tie2.songs[0].key).toBe("rosalia/candy");
  });

  describe("best result", () => {
    it("prefers the artist over an equally named album or song", () => {
      const lib = buildIndex(
        normalizeLibrary([
          file("a/1", "Signos", "Algo", { album: "Otra cosa" }),
          file("b/1", "Soda Stereo", "Signos", { album: "Signos" }),
        ])
      );
      const best = searchLibrary(lib, "signos").best;
      expect(best.kind).toBe("artist");
      expect(best.item.name).toBe("Signos");
    });

    it("prefers an exact album over a song that only contains the query", () => {
      const best = searchLibrary(INDEX, "motomami").best;
      expect(best.kind).toBe("album");
      expect(best.item.name).toBe("Motomami");
    });

    it("picks a song when its title is the closest match", () => {
      const best = searchLibrary(INDEX, "saoko").best;
      expect(best.kind).toBe("song");
      expect(best.item.key).toBe("rosalia/saoko");
    });

    it("falls back to the first artist, album or song when no name matches", () => {
      /* "saoko rosalia" cruza titulo y artista: ningun nombre la contiene. */
      const best = searchLibrary(INDEX, "saoko rosalia").best;
      expect(best.kind).toBe("song");
      expect(best.item.key).toBe("rosalia/saoko");
      expect(best.score).toBe(0);

      /* El album casa por su nombre y su artista, y va antes que las canciones. */
      const fromAlbum = searchLibrary(INDEX, "motomami rosalia").best;
      expect(fromAlbum.kind).toBe("album");
      expect(fromAlbum.item.name).toBe("Motomami");
    });
  });
});

describe("sortEntries", () => {
  it("sorts A-Z by title without touching the input", () => {
    const before = LIB.map((e) => e.key);
    const out = sortEntries(LIB, "az");
    expect(out[0].title).toBe("Azul");
    expect(out.map((e) => e.title).slice(0, 3)).toEqual(["Azul", "Azul en vivo", "Candy"]);
    expect(LIB.map((e) => e.key)).toEqual(before);
  });

  it("sorts by artist, then by title", () => {
    const out = sortEntries(LIB, "artist").map((e) => e.key);
    expect(out.slice(0, 1)).toEqual(["bb/titi"]);
    expect(out.slice(1, 4)).toEqual(["rosalia/candy", "rosalia/malamente", "rosalia/saoko"]);
  });

  it("sorts recent with the newest first and keeps ties in order", () => {
    const out = sortEntries(LIB, "recent").map((e) => e.key);
    expect(out[0]).toBe("zoe/video");
    expect(out[1]).toBe("bb/titi");
    const ties = sortEntries(
      normalizeLibrary([file("1", "A", "x", { modified: 7 }), file("2", "A", "y", { modified: 7 })]),
      "recent"
    );
    expect(ties.map((e) => e.key)).toEqual(["1", "2"]);
  });

  it("falls back to recent for an unknown mode", () => {
    expect(sortEntries(LIB, "otro")[0].key).toBe("zoe/video");
  });
});

describe("recentEntries", () => {
  it("returns the newest playable entries, without videos", () => {
    const keys = recentEntries(LIB, 3).map((e) => e.key);
    expect(keys).toEqual(["bb/titi", "soda/musica", "soda/signos"]);
  });

  it("handles n of 0 and larger than the library", () => {
    expect(recentEntries(LIB, 0)).toEqual([]);
    expect(recentEntries(LIB, 50)).toHaveLength(7);
  });
});

describe("topArtists and recentAlbums", () => {
  it("ranks artists by song count, then name", () => {
    const names = topArtists(INDEX.artists, 3).map((a) => a.name);
    expect(names).toEqual(["Rosalía", "Soda Stereo", "Zoé"]);
  });

  it("ranks albums by their newest song", () => {
    const names = recentAlbums(INDEX.albums, 2).map((a) => a.name);
    expect(names).toEqual(["Un verano sin ti", "Canción animal"]);
  });
});

describe("albumOrder", () => {
  it("keeps the download order and breaks ties by title", () => {
    const entries = normalizeLibrary([
      file("c", "A", "Cuarta", { modified: 5 }),
      file("a", "A", "Primera", { modified: 1 }),
      file("b", "A", "Beta", { modified: 5 }),
    ]);
    expect(albumOrder(entries).map((e) => e.key)).toEqual(["a", "b", "c"]);
  });
});

describe("continueItems", () => {
  const state = {
    ready: true,
    tracks: {},
    recent: [
      { key: "rosalia/saoko", last: 30, pos: 50_000, dur: 200_000, o: "partial" },
      { key: "gone/missing", last: 29, pos: 10_000, dur: 100_000, o: "partial" },
      { key: "zoe/video", last: 28, pos: 5_000, dur: 100_000, o: "partial" },
      { key: "soda/signos", last: 27, pos: 120_000, dur: 240_000, o: "partial" },
    ],
  };

  it("maps progress in seconds and skips missing keys and videos", () => {
    const items = continueItems(state, byKey, 5);
    expect(items.map((i) => i.entry.key)).toEqual(["rosalia/saoko", "soda/signos"]);
    expect(items[0]).toMatchObject({ pos: 50, dur: 200, left: 150, pct: 25, finished: false, at: 50 });
    expect(items[1]).toMatchObject({ pct: 50, left: 120 });
  });

  it("respects the limit", () => {
    expect(continueItems(state, byKey, 1)).toHaveLength(1);
    expect(continueItems(state, byKey, 0)).toEqual([]);
  });

  it("restarts a finished track from the beginning", () => {
    const done = {
      tracks: {},
      recent: [{ key: "zoe/azul", last: 5, pos: 195_000, dur: 200_000, o: "play" }],
    };
    const [item] = continueItems(done, byKey, 5);
    expect(item.finished).toBe(true);
    expect(item.at).toBe(0);
    expect(item.pct).toBe(98);
  });

  it("falls back to the library duration when the record has none", () => {
    const odd = { tracks: {}, recent: [{ key: "zoe/azul", last: 5, pos: 20_000, dur: 0 }] };
    const [item] = continueItems(odd, byKey, 5);
    expect(item.dur).toBe(200);
    expect(item.pct).toBe(10);
  });

  it("is empty with no history", () => {
    expect(continueItems({ recent: [] }, byKey, 5)).toEqual([]);
    expect(continueItems(undefined, byKey, 5)).toEqual([]);
  });
});

describe("topItems", () => {
  const state = {
    recent: [],
    tracks: {
      "rosalia/saoko": { plays: 5, last: 10 },
      "rosalia/candy": { plays: 5, last: 20 },
      "soda/signos": { plays: 2, last: 5 },
      "bb/titi": { plays: 0, skips: 4, last: 50 },
      "gone/missing": { plays: 99, last: 1 },
      "zoe/video": { plays: 50, last: 1 },
    },
  };

  it("orders by plays, then by the latest event, and filters the unplayed", () => {
    const items = topItems(state, byKey, 5);
    expect(items.map((i) => i.entry.key)).toEqual([
      "rosalia/candy",
      "rosalia/saoko",
      "soda/signos",
    ]);
    expect(items.map((i) => i.plays)).toEqual([5, 5, 2]);
  });

  it("respects the limit and handles no history", () => {
    expect(topItems(state, byKey, 1)).toHaveLength(1);
    expect(topItems({ tracks: {} }, byKey, 5)).toEqual([]);
    expect(topItems(undefined, byKey, 5)).toEqual([]);
  });
});

describe("covers", () => {
  it("gives the same hue to the same name, always in 0..359", () => {
    expect(hueOf("Rosalía")).toBe(hueOf("Rosalía"));
    expect(hueOf("Rosalía")).not.toBe(hueOf("Soda Stereo"));
    expect(hueOf("x")).toBeGreaterThanOrEqual(0);
    expect(hueOf("x")).toBeLessThan(360);
  });

  it("uses the album hue for a song with album and the artist's without", () => {
    expect(entryHue(byKey.get("rosalia/saoko"))).toBe(albumHue("Rosalía", "Motomami"));
    expect(entryHue(byKey.get("zoe/azul"))).toBe(hueOf("Zoé"));
  });

  it("builds a four-tone mosaic from the first songs still in the library", () => {
    const keys = ["gone/x", "rosalia/saoko", "soda/signos"];
    const hues = mosaicHues(keys, byKey);
    expect(hues).toHaveLength(4);
    expect(hues[0]).toBe(entryHue(byKey.get("rosalia/saoko")));
    expect(hues[1]).toBe(entryHue(byKey.get("soda/signos")));
    expect(hues[2]).toBe(hues[0]);
    expect(hues[3]).toBe(hues[0]);
  });

  it("caps the mosaic at four and is empty for a list with nothing left", () => {
    const keys = LIB.map((e) => e.key);
    expect(mosaicHues(keys, byKey)).toHaveLength(4);
    expect(mosaicHues(["gone/x"], byKey)).toEqual([]);
    expect(mosaicHues([], byKey)).toEqual([]);
  });
});

describe("labels", () => {
  it("pluralizes", () => {
    expect(plural(1, "canción", "canciones")).toBe("1 canción");
    expect(plural(0, "canción", "canciones")).toBe("0 canciones");
    expect(plural(12, "tema", "temas")).toBe("12 temas");
  });

  it("rounds minutes, at least 1, and is null without durations", () => {
    expect(minutes([{ duration: 200 }, { duration: 400 }])).toBe(10);
    expect(minutes([{ duration: 20 }])).toBe(1);
    expect(minutes([{ duration: null }])).toBeNull();
    expect(minutes([])).toBeNull();
  });
});
