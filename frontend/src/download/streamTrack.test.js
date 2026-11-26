import { describe, expect, it, vi } from "vitest";
import { canStream, previewKey, previewTrack, streamKey, streamQueue, streamTrack } from "./streamTrack.js";
import { autoSaver, quality } from "../settings/playbackSettings.js";

const WEB = "https://www.youtube.com/watch?v=abcdefghijk";
const full = {
  title: "Tema",
  artist: "Artista",
  album: "Disco",
  duration_s: 200,
  artwork_url: "https://i.ytimg.com/vi/x/hqdefault.jpg",
  source: "itunes",
  extra: { webpage_url: WEB },
};
const preview = { title: "Otro", preview_url: "https://itunes/30s", extra: {} };

describe("canStream", () => {
  it("is true only for a full result with a YouTube page", () => {
    expect(canStream(full)).toBe(true);
    expect(canStream(preview)).toBe(false);
    expect(canStream({ downloadable: true, extra: {} })).toBe(false);
    expect(canStream({ preview_url: "x", extra: { webpage_url: WEB } })).toBe(true);
  });
});

describe("streamTrack", () => {
  it("builds the object the engine plays, keeping the result for downloads", () => {
    const t = streamTrack(full, "search:blues");
    expect(t.key).toBe(`stream:${WEB}`);
    expect(t.src).toBe(`/api/stream?url=${encodeURIComponent(WEB)}`);
    expect(t.title).toBe("Tema");
    expect(t.label).toBe("Tema");
    expect(t.meta).toBe("Artista · Disco");
    expect(t.duration).toBe(200);
    expect(t.artwork).toBe(full.artwork_url);
    expect(t.kind).toBe("stream");
    expect(t.sid).toBe("yt:abcdefghijk");
    expect(t.artist).toBe("Artista");
    expect(t.result).toBe(full);
    expect(t.source).toBe("search:blues");
  });

  it("the chosen quality reaches the stream URL", () => {
    quality.set("high");
    autoSaver.set(false);
    try {
      expect(streamTrack(full).src).toBe(`/api/stream?url=${encodeURIComponent(WEB)}&quality=high`);
    } finally {
      quality.set("auto");
    }
  });

  it("omits an album equal to the title and uses unknown artist", () => {
    expect(streamTrack({ title: "Tema", album: "Tema", extra: { webpage_url: WEB } }).meta)
      .toBe("artista desconocido");
    expect(streamTrack({ title: "Tema", artist: "A", extra: { webpage_url: WEB } }).meta)
      .toBe("A");
  });

  it("uses one key per video", () => {
    expect(streamKey(WEB)).toBe(`stream:${WEB}`);
  });
});

describe("previewTrack", () => {
  it("builds the same 30 s track PreviewButton and the result row play", () => {
    const t = { title: "Otro", artist: "A", artwork_url: "https://a/x.jpg", preview_url: "https://itunes/30s", extra: {} };
    expect(previewKey(t)).toBe("preview:https://itunes/30s");
    expect(previewTrack(t)).toEqual({
      key: "preview:https://itunes/30s",
      src: "https://itunes/30s",
      title: "Otro",
      label: "el preview de Otro",
      meta: "A · preview de 30 s",
      duration: 30,
      artwork: "https://a/x.jpg",
      kind: "preview",
      result: t,
    });
  });
});

describe("streamQueue", () => {
  it("keeps the full results of the list in order and points at the chosen one", () => {
    const other = { ...full, title: "Otro", extra: { webpage_url: "https://www.youtube.com/watch?v=abcdefghijl" } };
    const { queue, index } = streamQueue([preview, full, other], full, "search:blues");
    expect(index).toBe(0);
    expect(queue.map((t) => t.title)).toEqual(["Tema", "Otro"]);
    expect(queue.every((t) => t.kind === "stream")).toBe(true);
  });

  it("falls back to a single track when the result is not in the list", () => {
    const { queue, index } = streamQueue([preview], full);
    expect(index).toBe(0);
    expect(queue).toHaveLength(1);
  });
});

describe("prepareTopStreams", () => {
  it("prepares the first two full results once each", async () => {
    const { prepareTopStreams } = await import("./api.js");
    const fetchFn = vi.fn(() => Promise.resolve());
    vi.stubGlobal("fetch", fetchFn);
    const full = (id) => ({ source: "ytdlp", extra: { has_full: true, webpage_url: `https://www.youtube.com/watch?v=${id}` } });
    const preview = { source: "itunes", preview_url: "https://x/p.m4a", extra: {} };
    const list = [preview, full("aaaaaaaaaaa"), full("bbbbbbbbbbb"), full("ccccccccccc")];
    prepareTopStreams(list);
    prepareTopStreams(list);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).url).toContain("aaaaaaaaaaa");
    expect(JSON.parse(fetchFn.mock.calls[1][1].body).url).toContain("bbbbbbbbbbb");
    vi.unstubAllGlobals();
  });
});

describe("archive audition", () => {
  const item = { source: "archive", source_id: "creep-1992", title: "Creep", artist: "Radiohead", extra: { needs_resolve: true } };

  it("only archive results that still need resolving can be heard first", async () => {
    const { canAudition } = await import("./streamTrack.js");
    expect(canAudition(item)).toBe(true);
    expect(canAudition({ ...item, extra: {} })).toBe(false);
    expect(canAudition({ ...item, source: "itunes" })).toBe(false);
  });

  it("plays the exact file the verification found", async () => {
    const { listenArchive } = await import("./ArchiveListenButton.jsx");
    const recs = new Map();
    const store = {
      get: (k) => recs.get(k),
      verify: vi.fn(async (t, q) => { recs.set(`archive${t.source_id}|${q}`, { audio: "https://ia.example/creep.mp3" }); }),
    };
    const player = { play: vi.fn() };
    expect(await listenArchive(item, "creep", { store, player })).toBe(true);
    expect(store.verify).toHaveBeenCalledOnce();
    const track = player.play.mock.calls[0][0];
    expect(track).toMatchObject({ key: "archive:creep-1992", src: "https://ia.example/creep.mp3", kind: "stream", sid: null, result: item });

    await listenArchive(item, "creep", { store, player });
    expect(store.verify).toHaveBeenCalledOnce(); // la segunda vez reusa la URL
  });

  it("does not play when the verification found no file", async () => {
    const { listenArchive } = await import("./ArchiveListenButton.jsx");
    const store = { get: () => undefined, verify: vi.fn(async () => {}) };
    const player = { play: vi.fn() };
    expect(await listenArchive(item, "creep", { store, player })).toBe(false);
    expect(player.play).not.toHaveBeenCalled();
  });
});

describe("restricted archive items", () => {
  it("does not play an item archive.org will not serve", async () => {
    const { listenArchive } = await import("./ArchiveListenButton.jsx");
    const item = { source: "archive", source_id: "x", title: "X", extra: { needs_resolve: true } };
    const recs = new Map();
    const store = {
      get: (k) => recs.get(k),
      verify: vi.fn(async (t, q) => { recs.set(`archive${t.source_id}|${q}`, { audio: "https://ia/x.mp3", extra: { unreadable: true } }); }),
    };
    const player = { play: vi.fn() };
    expect(await listenArchive(item, "x", { store, player })).toBe(false);
    expect(player.play).not.toHaveBeenCalled();
  });
});
