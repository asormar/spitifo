import { describe, expect, it } from "vitest";
import { songFromResult, songIdOf } from "./songId.js";

const WEB = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const yt = (extra = {}) => ({
  source: "itunes",
  source_id: "123456789",
  title: "Tema",
  artist: "Artista",
  album: "Disco",
  duration_s: 200,
  artwork_url: "https://img/tema.jpg",
  extra: { webpage_url: WEB, collection_id: 42, track_number: 3, ...extra },
});

describe("songIdOf", () => {
  it("builds a YouTube id from the webpage_url v param", () => {
    expect(songIdOf(yt())).toBe("yt:dQw4w9WgXcQ");
    expect(songIdOf({ source: "itunes", extra: { webpage_url: WEB + "&list=abc" } }))
      .toBe("yt:dQw4w9WgXcQ");
  });

  it("falls back to the ytdlp source_id", () => {
    expect(songIdOf({ source: "ytdlp", source_id: "dQw4w9WgXcQ" }))
      .toBe("yt:dQw4w9WgXcQ");
    expect(songIdOf({ source: "ytdlp", source_id: "corta" })).toBe(null);
  });

  it("builds an Archive id from the identifier and the chosen file", () => {
    const item = {
      source: "archive",
      source_id: "olivia-1969",
      extra: { needs_resolve: true, filename: "disco 2/01 Olivia.mp3" },
    };
    expect(songIdOf(item)).toBe("ia:olivia-1969/disco 2/01 Olivia.mp3");
    expect(songIdOf({ ...item, filename: "otro.mp3", extra: {} }))
      .toBe("ia:olivia-1969/otro.mp3");
  });

  it("rejects archive files that cannot be a saved id, and previews", () => {
    const base = { source: "archive", source_id: "olivia-1969" };
    expect(songIdOf({ ...base, extra: { filename: "../fuera.mp3" } })).toBe(null);
    expect(songIdOf({ ...base, extra: { filename: "a?b.mp3" } })).toBe(null);
    expect(songIdOf({ ...base, extra: {} })).toBe(null);
    expect(songIdOf({ source: "itunes", preview_url: "https://x/p.m4a", extra: {} }))
      .toBe(null);
    expect(songIdOf(null)).toBe(null);
  });
});

describe("songFromResult", () => {
  it("builds the PUT /api/saved record with the exact expected fields", () => {
    expect(songFromResult(yt())).toEqual({
      id: "yt:dQw4w9WgXcQ",
      title: "Tema",
      artist: "Artista",
      album: "Disco",
      duration: 200,
      artwork_url: "https://img/tema.jpg",
      source: "youtube",
      source_id: "dQw4w9WgXcQ",
      itunes: { collection_id: 42, track_no: 3, track_id: 123456789 },
      file_key: null,
    });
  });

  it("uses the archive source_id when the result has no webpage_url", () => {
    const rec = songFromResult({
      source: "archive",
      source_id: "olivia-1969",
      title: "Olivia",
      artist: "Varios",
      extra: { filename: "01 Olivia.mp3" },
    });
    expect(rec.id).toBe("ia:olivia-1969/01 Olivia.mp3");
    expect(rec.source).toBe("archive");
    expect(rec.source_id).toBe("olivia-1969/01 Olivia.mp3");
    expect(rec.file_key).toBe(null);
  });

  it("accepts an engine track that already carries a sid", () => {
    const rec = songFromResult({
      sid: "ia:olivia-1969/01 Olivia.mp3",
      title: "Olivia",
      artist: "Varios",
      duration: 180,
      artwork: "https://img/ia.jpg",
    });
    expect(rec.id).toBe("ia:olivia-1969/01 Olivia.mp3");
    expect(rec.duration).toBe(180);
    expect(rec.artwork_url).toBe("https://img/ia.jpg");
  });

  it("returns null when there is no stable id", () => {
    expect(songFromResult({ source: "itunes", extra: {} })).toBe(null);
    expect(songFromResult(null)).toBe(null);
  });
});
