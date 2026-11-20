import { describe, expect, it, vi } from "vitest";
import { needsResolve, resolveResult } from "./resolveResult.js";

const pending = () => ({
  source: "itunes",
  source_id: "123",
  title: "Tema",
  artist: "Artista",
  extra: { needs_resolve: true },
});
const reply = (body, ok = true) => ({ ok, json: async () => body });

describe("needsResolve", () => {
  it("only asks for the sources that still need a file", () => {
    expect(needsResolve(pending())).toBe(true);
    expect(needsResolve({ ...pending(), extra: { webpage_url: "https://youtu.be/x" } })).toBe(false);
    expect(needsResolve({ ...pending(), source: "ytdlp" })).toBe(false);
    expect(needsResolve({ ...pending(), audio_url: "https://x" })).toBe(false);
    expect(needsResolve({ source: "ytdlp", source_id: "dQw4w9WgXcQ" })).toBe(false);
  });
});

describe("resolveResult", () => {
  it("keeps a result that already has an id and makes no request", async () => {
    const t = { source: "ytdlp", source_id: "dQw4w9WgXcQ" };
    const fetchFn = vi.fn();
    expect(await resolveResult(t, "q", fetchFn)).toBe(t);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("uses the same /api/resolve call as the download", async () => {
    const t = pending();
    const resolved = { ...t, extra: { webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } };
    const fetchFn = vi.fn(async () => reply(resolved));
    expect(await resolveResult(t, "Artista Tema", fetchFn)).toEqual(resolved);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toContain("/api/resolve?query=Artista%20Tema");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body).source).toBe("itunes");
  });

  it("throws when the server cannot resolve it", async () => {
    const fetchFn = vi.fn(async () => reply({ detail: "sin video" }, false));
    await expect(resolveResult(pending(), "", fetchFn)).rejects.toThrow();
  });
});
