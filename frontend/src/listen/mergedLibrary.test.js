import { describe, expect, it } from "vitest";
import { mergeLibrary } from "./mergedLibrary.js";
import { buildIndex, searchLibrary } from "./home.js";

const file = (key, extra = {}) => ({
  key,
  filename: "Tema.mp3",
  folder: "Artista",
  title: "Tema",
  artist: "Artista",
  album: "Disco",
  duration_s: 120,
  modified: 1000,
  kind: "audio",
  has_audio: true,
  ...extra,
});

const song = (id, extra = {}) => ({
  id,
  title: "Tema",
  artist: "Artista",
  album: "Disco",
  duration: 120,
  artwork_url: "https://img.example/t.jpg",
  source: id.startsWith("yt:") ? "youtube" : "archive",
  source_id: id.slice(3),
  itunes: {},
  file_key: null,
  added_at: 2000,
  updated_at: 2000,
  ...extra,
});

const byId = (...songs) => new Map(songs.map((s) => [s.id, s]));

describe("mergeLibrary", () => {
  it("keeps a file without a record as an implicitly saved, downloaded row", () => {
    const { entries, byKey } = mergeLibrary([file("A/a.mp3")], new Map());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: "A/a.mp3", downloaded: true });
    expect(entries[0].sid).toBeUndefined();
    expect(byKey.get("A/a.mp3")).toBe(entries[0]);
  });

  it("makes one entry per saved song with a live file, reachable by both keys", () => {
    const saved = song("yt:dQw4w9WgXcQ", { file_key: "A/a.mp3" });
    const { entries, byKey } = mergeLibrary([file("A/a.mp3")], byId(saved));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: "A/a.mp3", sid: saved.id, song: saved, downloaded: true,
    });
    expect(byKey.get(saved.id)).toBe(entries[0]);
    expect(byKey.get("A/a.mp3")).toBe(entries[0]);
  });

  it("adds a stream row for a saved song without a live file", () => {
    const saved = song("ia:item/01.mp3", { added_at: 4321 });
    const { entries, byKey } = mergeLibrary([], byId(saved));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: saved.id, sid: saved.id, kind: "stream", added: 4321, downloaded: false,
      artworkUrl: saved.artwork_url,
    });
    expect(byKey.get(saved.id)).toBe(entries[0]);
  });

  it("falls back to a stream row when the recorded file is gone", () => {
    const saved = song("yt:dQw4w9WgXcQ", { file_key: "A/borrada.mp3" });
    const { entries } = mergeLibrary([], byId(saved));
    expect(entries).toHaveLength(1);
    expect(entries[0].downloaded).toBe(false);
  });

  it("includes saved songs in groups and search through the merged index", () => {
    const saved = song("yt:dQw4w9WgXcQ");
    const { entries } = mergeLibrary([file("A/a.mp3")], byId(saved));
    const index = buildIndex(entries);
    expect(index.artists).toHaveLength(1);
    expect(index.artists[0].entries).toHaveLength(2);
    expect(index.albums[0].entries).toHaveLength(2);
    const r = searchLibrary(index, "tema", {});
    expect(r.songs.map((e) => e.key)).toEqual(["A/a.mp3", saved.id]);
  });
});
