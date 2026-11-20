import { describe, expect, it } from "vitest";
import { resultOf, savedEntry, savedTrack, tracksFor } from "./savedTrack.js";
import { songFromResult, songIdOf } from "../shared/songId.js";

const WEB = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const youtube = {
  id: "yt:dQw4w9WgXcQ",
  title: "Tema",
  artist: "Artista",
  album: "Disco",
  duration: 200,
  artwork_url: "https://img/tema.jpg",
  source: "youtube",
  source_id: "dQw4w9WgXcQ",
  file_key: null,
};
const archive = {
  ...youtube,
  id: "ia:olivia-1969/01 Olivia.mp3",
  title: "Olivia",
  artist: "Varios",
  source: "archive",
  source_id: "olivia-1969/01 Olivia.mp3",
};

describe("savedTrack", () => {
  it("streams a YouTube song with the same key streamTrack would give", () => {
    const t = savedTrack(youtube);
    expect(t.key).toBe(`stream:${WEB}`);
    expect(t.src).toBe(`/api/stream?url=${encodeURIComponent(WEB)}`);
    expect(t).toMatchObject({
      kind: "stream", sid: youtube.id, title: "Tema",
      meta: "Artista · Disco", duration: 200,
      artwork: "https://img/tema.jpg", artist: "Artista",
    });
  });

  it("streams an Archive song from the exact file, encoding each segment", () => {
    const t = savedTrack(archive);
    expect(t.key).toBe("archive:olivia-1969/01 Olivia.mp3");
    expect(t.src).toBe("https://archive.org/download/olivia-1969/01%20Olivia.mp3");
    expect(t.sid).toBe(archive.id);
  });

  it("uses the downloaded file when it is still in the library", () => {
    const entry = {
      key: "Artista/Tema.mp3",
      title: "Tema",
      artist: "Artista",
      album: "Disco",
      duration: 200,
      thumbKey: "Artista/Tema.jpg",
      kind: "audio",
    };
    const song = { ...youtube, file_key: entry.key };
    const t = savedTrack(song, new Map([[entry.key, entry]]));
    expect(t.kind).toBe("library");
    expect(t.src).toBe(`/api/audio?key=${encodeURIComponent(entry.key)}`);
    expect(t.sid).toBe(song.id);
    expect(t.key).toBe(song.id);
  });

  it("falls back to streaming when the file_key is gone from the library", () => {
    const song = { ...youtube, file_key: "Artista/Tema.mp3" };
    expect(savedTrack(song, new Map()).kind).toBe("stream");
    expect(savedTrack(null)).toBe(null);
  });
});

describe("savedEntry and tracksFor", () => {
  it("makes a row for a saved song that has no file", () => {
    const e = savedEntry(archive);
    expect(e).toMatchObject({
      key: archive.id, sid: archive.id, kind: "stream",
      title: "Olivia", artist: "Varios", artworkUrl: archive.artwork_url,
    });
  });

  it("keeps library rows as they were and converts saved ids", () => {
    const file = { key: "A/Uno.mp3", kind: "audio", title: "Uno", artist: "A" };
    const rows = [file, savedEntry(youtube)];
    const queue = tracksFor(rows, new Map(), new Map(), (k) => `/audio/${k}`);
    expect(queue[0].key).toBe(file.key);
    expect(queue[0].kind).toBe("library");
    expect(queue[1].sid).toBe(youtube.id);
    expect(queue[1].kind).toBe("stream");
  });

  it("skips videos", () => {
    expect(tracksFor([{ kind: "video", key: "v" }], new Map(), new Map()))
      .toEqual([]);
  });
});

describe("resultOf", () => {
  it("gives a saved YouTube song the shape of a ytdlp search result", () => {
    const r = resultOf({
      id: "yt:eBG7P-K-r1Y", title: "Everlong", artist: "Foo Fighters", album: "The Colour",
      duration: 250, source: "youtube", source_id: "eBG7P-K-r1Y",
      itunes: { collection_id: 7, track_no: 3 },
    });
    expect(r.source).toBe("ytdlp");
    expect(r.extra.webpage_url).toBe("https://www.youtube.com/watch?v=eBG7P-K-r1Y");
    expect(r.extra.collection_id).toBe(7);
    expect(r.extra.track_number).toBe(3);
    expect(songIdOf(r)).toBe("yt:eBG7P-K-r1Y");
    expect(songFromResult(r).itunes).toEqual({ collection_id: 7, track_no: 3 });
  });

  it("splits an Archive id into item and file", () => {
    const r = resultOf({ id: "ia:show_77/disc 2/03 Tema.flac", source: "archive", itunes: {} });
    expect(r.source).toBe("archive");
    expect(r.source_id).toBe("show_77");
    expect(r.extra.filename).toBe("disc 2/03 Tema.flac");
    expect(songIdOf(r)).toBe("ia:show_77/disc 2/03 Tema.flac");
  });
});
