import { describe, expect, it } from "vitest";
import {
  filterEntries,
  fold,
  groupAlbums,
  groupArtists,
  normalizeEntry,
  normalizeLibrary,
  toQueue,
  visibleRange,
} from "./library.js";

const file = (overrides = {}) => ({
  key: "k",
  filename: "Song.mp3",
  folder: "Artist",
  bytes: 1024,
  size_mb: 1,
  duration_s: 120,
  modified: "2026-01-01",
  kind: "audio",
  thumb_key: null,
  has_audio: true,
  ...overrides,
});

describe("fold", () => {
  it("lowercases, strips accents and trims", () => {
    expect(fold("  Canción Ñandú ")).toBe("cancion nandu");
    expect(fold("Álvaro")).toBe("alvaro");
  });

  it("is null-safe", () => {
    expect(fold(null)).toBe("");
    expect(fold(undefined)).toBe("");
  });
});

describe("normalizeEntry", () => {
  it("keeps the tags when they are present", () => {
    const entry = normalizeEntry(
      file({
        key: "k1",
        filename: "track.mp3",
        folder: "Folder",
        title: "Song",
        artist: "Artist",
        album: "Album",
        size_mb: 3.5,
        duration_s: 200,
        thumb_key: "thumb-1",
      })
    );
    expect(entry).toEqual({
      key: "k1",
      kind: "audio",
      title: "Song",
      artist: "Artist",
      album: "Album",
      duration: 200,
      filename: "track.mp3",
      folder: "Folder",
      sizeMb: 3.5,
      thumbKey: "thumb-1",
      added: 0,
      hasAudio: true,
      search: "song artist album",
    });
  });

  it("keeps the modification time as the added date", () => {
    expect(normalizeEntry(file({ modified: 1760000000.5 })).added).toBe(1760000000.5);
    expect(normalizeEntry(file({ modified: undefined })).added).toBe(0);
  });

  it("falls back to the folder and the Artist - Title filename", () => {
    const entry = normalizeEntry({
      key: "k2",
      filename: "Los Fabulosos - La Cumbia.mp3",
      folder: "Los Fabulosos",
      kind: "audio",
      size_mb: 2,
      duration_s: null,
      has_audio: false,
      thumb_key: null,
    });
    expect(entry.artist).toBe("Los Fabulosos");
    expect(entry.title).toBe("La Cumbia");
    expect(entry.album).toBe("");
    expect(entry.duration).toBeNull();
    expect(entry.search).toBe("la cumbia los fabulosos");
  });

  it("keeps a filename that does not start with the artist", () => {
    const entry = normalizeEntry(
      file({ key: "k3", filename: "Otra Cancion.mp3", folder: "Artista X" })
    );
    expect(entry.artist).toBe("Artista X");
    expect(entry.title).toBe("Otra Cancion");
  });

  it("falls back to an unknown artist without a folder", () => {
    const entry = normalizeEntry({ key: "k4", filename: "Suelta.mp3" });
    expect(entry.artist).toBe("Artista desconocido");
    expect(entry.title).toBe("Suelta");
  });

  it("normalizes a library keeping the backend order", () => {
    const entries = normalizeLibrary([
      file({ key: "first" }),
      file({ key: "second" }),
    ]);
    expect(entries.map((entry) => entry.key)).toEqual(["first", "second"]);
  });
});

describe("filterEntries", () => {
  const entries = [
    normalizeEntry(
      file({ key: "1", filename: "Canción Ñandú.mp3", folder: "Los Fabulosos" })
    ),
    normalizeEntry(file({ key: "2", filename: "Otra.mp3", folder: "Zoe" })),
  ];

  it("returns the same array for an empty query", () => {
    expect(filterEntries(entries, "")).toBe(entries);
    expect(filterEntries(entries, "   ")).toBe(entries);
    expect(filterEntries(entries, null)).toBe(entries);
  });

  it("matches every term without accents or case", () => {
    expect(filterEntries(entries, "cancion nandu").map((e) => e.key)).toEqual(["1"]);
    expect(filterEntries(entries, "CANCION fabulosos").map((e) => e.key)).toEqual([
      "1",
    ]);
    expect(filterEntries(entries, "zoe").map((e) => e.key)).toEqual(["2"]);
  });
});

describe("groupArtists", () => {
  it("sorts case-insensitively and counts distinct albums", () => {
    const entries = [
      normalizeEntry(
        file({ key: "1", filename: "uno.mp3", folder: "zoe", album: "Reptilectric" })
      ),
      normalizeEntry(
        file({ key: "2", filename: "dos.mp3", folder: "Álvaro", album: "Uno" })
      ),
      normalizeEntry(
        file({ key: "3", filename: "tres.mp3", folder: "Álvaro", album: "Dos" })
      ),
      normalizeEntry(file({ key: "4", filename: "cuatro.mp3", folder: "Álvaro" })),
      normalizeEntry(
        file({ key: "5", filename: "cinco.mp3", folder: "álvaro", album: "UNO" })
      ),
    ];

    const groups = groupArtists(entries);
    expect(groups.map((group) => group.name)).toEqual(["Álvaro", "zoe"]);
    expect(groups[0].id).toBe("artist:alvaro");
    expect(groups[0].entries.map((entry) => entry.key)).toEqual([
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(groups[0].albumCount).toBe(2);
    expect(groups[1].albumCount).toBe(1);
  });
});

describe("groupAlbums", () => {
  const entries = [
    normalizeEntry(
      file({ key: "1", filename: "a.mp3", folder: "Artista A", album: "Compartido" })
    ),
    normalizeEntry(
      file({ key: "2", filename: "b.mp3", folder: "Artista B", album: "Compartido" })
    ),
    normalizeEntry(file({ key: "3", filename: "c.mp3", folder: "Artista A" })),
    normalizeEntry(
      file({ key: "4", filename: "d.mp3", folder: "Artista A", album: "Zeta" })
    ),
    normalizeEntry(
      file({ key: "5", filename: "e.mp3", folder: "Artista B", album: "Alfa" })
    ),
  ];

  it("skips entries without an album", () => {
    const albums = groupAlbums(entries);
    expect(albums).toHaveLength(4);
    expect(albums.some((album) => album.entries.some((e) => e.key === "3"))).toBe(
      false
    );
    expect(albums.every((album) => album.name)).toBe(true);
  });

  it("sorts by name and artist, and splits the same name by artist", () => {
    const albums = groupAlbums(entries);
    expect(albums.map((album) => album.name)).toEqual([
      "Alfa",
      "Compartido",
      "Compartido",
      "Zeta",
    ]);
    expect(albums.map((album) => album.id)).toEqual([
      "album:artista b|alfa",
      "album:artista a|compartido",
      "album:artista b|compartido",
      "album:artista a|zeta",
    ]);
    const shared = albums.filter((album) => album.name === "Compartido");
    expect(shared.map((album) => album.artist)).toEqual(["Artista A", "Artista B"]);
    expect(shared[0].entries.map((entry) => entry.key)).toEqual(["1"]);
  });
});

describe("toQueue", () => {
  it("skips videos and maps the rest to engine tracks", () => {
    const entries = [
      normalizeEntry(
        file({ key: "a", filename: "Song.mp3", folder: "Artista", album: "Disco" })
      ),
      normalizeEntry(file({ key: "v", filename: "Clip.mp4", kind: "video" })),
      normalizeEntry(file({ key: "b", filename: "Otra.mp3", folder: "Artista" })),
    ];

    const tracks = toQueue(entries, (key) => `/api/media/${key}`);
    expect(tracks.map((track) => track.key)).toEqual(["a", "b"]);
    expect(tracks[0]).toEqual({
      key: "a",
      src: "/api/media/a",
      title: "Song",
      meta: "Artista · Disco",
      duration: 120,
      artwork: null,
      kind: "library",
      label: "Song, Artista",
    });
    expect(tracks[1].meta).toBe("Artista");
  });

  it("points the artwork at the thumbnail sidecar when there is one", () => {
    const keyUrl = (key) => `/api/media/${key}`;
    const withThumb = normalizeEntry(file({ key: "a", thumb_key: "x/a.jpg" }));
    const without = normalizeEntry(file({ key: "b" }));
    expect(toQueue([withThumb], keyUrl)[0].artwork).toBe("/api/media/x/a.jpg");
    expect(toQueue([without], keyUrl)[0].artwork).toBeNull();
  });
});

describe("visibleRange", () => {
  it("returns the window at the top", () => {
    expect(
      visibleRange({ scrollTop: 0, viewport: 200, rowHeight: 20, count: 1000 })
    ).toEqual({ start: 0, end: 18 });
  });

  it("returns the window in the middle", () => {
    expect(
      visibleRange({ scrollTop: 500, viewport: 200, rowHeight: 20, count: 1000 })
    ).toEqual({ start: 17, end: 43 });
  });

  it("clamps the end to the row count", () => {
    expect(
      visibleRange({ scrollTop: 19900, viewport: 200, rowHeight: 20, count: 1000 })
    ).toEqual({ start: 987, end: 1000 });
  });

  it("clamps a negative scrollTop to zero", () => {
    expect(
      visibleRange({ scrollTop: -100, viewport: 200, rowHeight: 20, count: 1000 })
    ).toEqual({ start: 0, end: 13 });
  });

  it("returns an empty range for an empty list", () => {
    expect(
      visibleRange({ scrollTop: 100, viewport: 200, rowHeight: 20, count: 0 })
    ).toEqual({ start: 0, end: 0 });
  });
});
