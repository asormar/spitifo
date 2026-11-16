import { describe, expect, it, vi } from "vitest";
import { EMPTY_TTL, chipsFor, createGenreCache, loadGenres } from "./genreChips.js";

const map = (extra = {}) => ({
  n: ["hip hop", "Bossa Nová", "post-punk", "rock", "pop"],
  c: [3, 7, 12, 0, 40],
  ...extra,
});
const g = (name, share) => ({ name, share });

describe("chipsFor", () => {
  it("keeps only the genres the map knows, with the map's name and cluster", () => {
    const out = chipsFor([g("rock", 0.5), g("zzz unknown", 0.3), g("hip hop", 0.2)], map());
    expect(out).toEqual([
      { name: "rock", cluster: 0 },
      { name: "hip hop", cluster: 3 },
    ]);
  });

  it("matches without accents or case", () => {
    expect(chipsFor([g("bossa nova", 1)], map())).toEqual([{ name: "Bossa Nová", cluster: 7 }]);
    expect(chipsFor([g("POST-PUNK", 1)], map())).toEqual([{ name: "post-punk", cluster: 12 }]);
  });

  it("orders by share and stops at four", () => {
    const genres = [g("pop", 0.1), g("rock", 0.4), g("post-punk", 0.3), g("hip hop", 0.15), g("Bossa Nová", 0.05)];
    expect(chipsFor(genres, map()).map((c) => c.name)).toEqual(["rock", "post-punk", "hip hop", "pop"]);
    expect(chipsFor(genres, map(), 2)).toHaveLength(2);
  });

  it("clamps the cluster to 0-15 and defaults a bad one to 0", () => {
    expect(chipsFor([g("pop", 1)], map())[0].cluster).toBe(15);
    expect(chipsFor([g("rock", 1)], map({ c: [0, 0, 0, -4, 0] }))[0].cluster).toBe(0);
    expect(chipsFor([g("rock", 1)], map({ c: null }))[0].cluster).toBe(0);
    expect(chipsFor([g("rock", 1)], map({ c: ["x", 0, 0, "x", 0] }))[0].cluster).toBe(0);
  });

  it("does not repeat a genre that two names fold to", () => {
    expect(chipsFor([g("Rock", 0.6), g("rock", 0.4)], map())).toHaveLength(1);
  });

  it("is empty for a bad or absent map or for no genres", () => {
    expect(chipsFor([g("rock", 1)], null)).toEqual([]);
    expect(chipsFor([g("rock", 1)], {})).toEqual([]);
    expect(chipsFor([g("rock", 1)], { n: "rock" })).toEqual([]);
    expect(chipsFor([], map())).toEqual([]);
    expect(chipsFor(null, map())).toEqual([]);
  });

  it("rebuilds the index when the map object changes", () => {
    const a = map();
    const b = { n: ["jazz"], c: [5] };
    expect(chipsFor([g("jazz", 1)], a)).toEqual([]);
    expect(chipsFor([g("jazz", 1)], b)).toEqual([{ name: "jazz", cluster: 5 }]);
    expect(chipsFor([g("rock", 1)], a)).toHaveLength(1);
  });
});

describe("genre cache", () => {
  it("keeps an answer with genres for the whole session", () => {
    let t = 0;
    const cache = createGenreCache(() => t);
    cache.set("A", [g("rock", 1)]);
    t = 10 * EMPTY_TTL;
    expect(cache.get("A")).toEqual([g("rock", 1)]);
  });

  it("forgets an empty answer after 30 s", () => {
    let t = 1000;
    const cache = createGenreCache(() => t);
    cache.set("A", []);
    t += EMPTY_TTL - 1;
    expect(cache.get("A")).toEqual([]);
    t += 2;
    expect(cache.get("A")).toBeUndefined();
  });

  it("answers undefined for a name it never saw", () => {
    expect(createGenreCache().get("nobody")).toBeUndefined();
  });
});

describe("loadGenres", () => {
  const ok = (genres) => vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ genres }) }));

  it("asks the backend once per artist and then answers from the cache", async () => {
    const fetcher = ok([g("rock", 1)]);
    const cache = createGenreCache();
    expect(await loadGenres("Nick Cave & The Bad Seeds", { cache, fetcher })).toEqual([g("rock", 1)]);
    await loadGenres("Nick Cave & The Bad Seeds", { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/artist/genres?name=Nick%20Cave%20%26%20The%20Bad%20Seeds");
  });

  it("shares a request that is already in flight", async () => {
    const fetcher = ok([g("pop", 1)]);
    const cache = createGenreCache();
    await Promise.all([loadGenres("B", { cache, fetcher }), loadGenres("B", { cache, fetcher })]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats a failure as empty and does not cache it", async () => {
    const cache = createGenreCache();
    const bad = vi.fn(() => Promise.reject(new Error("offline")));
    expect(await loadGenres("C", { cache, fetcher: bad })).toEqual([]);
    const http = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
    expect(await loadGenres("C", { cache, fetcher: http })).toEqual([]);
    const fine = ok([g("rock", 1)]);
    expect(await loadGenres("C", { cache, fetcher: fine })).toEqual([g("rock", 1)]);
  });

  it("caches an empty answer (not profiled yet) until it expires", async () => {
    let t = 0;
    const cache = createGenreCache(() => t);
    const fetcher = ok([]);
    await loadGenres("D", { cache, fetcher });
    await loadGenres("D", { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    t += EMPTY_TTL + 1;
    await loadGenres("D", { cache, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("ignores a body without a genres list", async () => {
    const fetcher = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ nope: 1 }) }));
    expect(await loadGenres("E", { cache: createGenreCache(), fetcher })).toEqual([]);
  });
});
