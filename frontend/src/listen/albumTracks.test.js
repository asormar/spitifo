import { describe, expect, it } from "vitest";
import { mergeAlbumTracks, mostCommonAlbumId } from "./albumTracks.js";
import { normalizeEntry } from "./library.js";

const entry = (key, title, extra = {}) =>
  normalizeEntry({
    key,
    filename: `${title}.mp3`,
    folder: "Soda Stereo",
    artist: "Soda Stereo",
    album: "Canción animal",
    kind: "audio",
    duration_s: 200,
    modified: 1,
    has_audio: true,
    ...extra,
  });

const itunes = (title, track_number, disc_number = 1) => ({
  title,
  source: "itunes",
  source_id: String(track_number),
  extra: { track_number, disc_number },
});

describe("mostCommonAlbumId", () => {
  it("takes the most repeated id, or null when there is none", () => {
    expect(
      mostCommonAlbumId([
        entry("a", "A", { album_id: "11" }),
        entry("b", "B", { album_id: "22" }),
        entry("c", "C", { album_id: "11" }),
        entry("d", "D"),
      ])
    ).toBe("11");
    expect(mostCommonAlbumId([entry("a", "A")])).toBeNull();
  });
});

describe("mergeAlbumTracks", () => {
  it("owns tracks by disc and track number even when the title differs", () => {
    const songs = [
      entry("n2", "Té para tres - remaster", { disc_no: 1, track_no: 7, album_id: "11" }),
      entry("n1", "Cae el sol", { disc_no: 1, track_no: 8, album_id: "11" }),
    ];
    const { rows, have, total } = mergeAlbumTracks(songs, [
      itunes("Té para tres", 7),
      itunes("Cae el sol", 8),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["n2", "n1"]);
    expect(rows.every((r) => r.type === "entry" && r.owned)).toBe(true);
    expect([have, total]).toEqual([2, 2]);
  });

  it("owns tracks by folded title when there are no numbers", () => {
    const songs = [entry("a", "De Música Ligera")];
    const { rows, have } = mergeAlbumTracks(songs, [itunes("de musica ligera", 9)]);
    expect(rows[0].type).toBe("entry");
    expect(rows[0].key).toBe("a");
    expect(have).toBe(1);
  });

  it("puts missing tracks in their disc position", () => {
    const songs = [entry("a", "Canción animal", { disc_no: 1, track_no: 3 }), entry("c", "Hombre al agua", { disc_no: 1, track_no: 5 })];
    const { rows, have, total } = mergeAlbumTracks(songs, [
      itunes("Canción animal", 3),
      itunes("1990", 4),
      itunes("Hombre al agua", 5),
    ]);
    expect(rows.map((r) => r.type)).toEqual(["entry", "missing", "entry"]);
    expect(rows[1].key).toBe("missing:1-4");
    expect(rows[1].title).toBe("1990");
    expect(rows.map((r) => r.num)).toEqual([1, 2, 3]);
    expect([have, total]).toEqual([2, 3]);
  });

  it("keeps owned entries that matched nothing after the numbered ones", () => {
    const songs = [
      entry("extra", "Bonus track"),
      entry("a", "Saoko", { disc_no: 1, track_no: 1 }),
    ];
    const { rows, have } = mergeAlbumTracks(songs, [itunes("Saoko", 1)]);
    expect(rows.map((r) => r.key)).toEqual(["a", "extra"]);
    expect(rows[1].owned).toBe(false);
    expect(have).toBe(1);
  });

  it("leaves today's rows untouched when the tracklist is unknown", () => {
    const songs = [entry("b", "B", { modified: 9 }), entry("a", "A", { modified: 2 })];
    const { rows, have, total } = mergeAlbumTracks(songs, null);
    expect(rows.map((r) => r.key)).toEqual(["b", "a"]);
    expect(rows.every((r) => r.type === "entry")).toBe(true);
    expect([have, total]).toEqual([null, null]);
  });
});
