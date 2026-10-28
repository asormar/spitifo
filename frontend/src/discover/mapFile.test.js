import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMapFile, forgetMapFile } from "./mapFile.js";

const reply = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

afterEach(() => {
  forgetMapFile();
  vi.unstubAllGlobals();
});

describe("fetchMapFile", () => {
  it("asks for genre-map.json once and shares the answer", async () => {
    const fetchFn = vi.fn(async () => reply({ n: ["a"] }));
    vi.stubGlobal("fetch", fetchFn);
    const [a, b] = await Promise.all([fetchMapFile(), fetchMapFile()]);
    expect(a).toBe(b);
    expect(await fetchMapFile()).toBe(a);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toMatch(/genre-map\.json$/);
  });

  it("forgets a failure so the next call asks again", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(reply({}, false, 503))
      .mockResolvedValueOnce(reply({ n: ["a"] }));
    vi.stubGlobal("fetch", fetchFn);
    await expect(fetchMapFile()).rejects.toThrow("HTTP 503");
    await expect(fetchMapFile()).resolves.toEqual({ n: ["a"] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("can be forgotten by hand (a file in the wrong format)", async () => {
    const fetchFn = vi.fn(async () => reply({ n: ["a"] }));
    vi.stubGlobal("fetch", fetchFn);
    await fetchMapFile();
    forgetMapFile();
    await fetchMapFile();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
