import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFormats, formatsCache, prepareTopStreams, warmDownload } from "./api.js";

const json = (data) => ({ ok: true, json: async () => data });

afterEach(() => {
  formatsCache.clear();
  vi.unstubAllGlobals();
});

describe("fetchFormats", () => {
  it("una segunda llamada con la misma URL no vuelve a pedir", async () => {
    const fetchMock = vi.fn(async () => json({ duration_s: 1, resolutions: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchFormats("https://x/1");
    await fetchFormats("https://x/1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("se acota a 100 entradas: la mas vieja se desaloja y se vuelve a pedir", async () => {
    const fetchMock = vi.fn(async () => json({ duration_s: 1, resolutions: [] }));
    vi.stubGlobal("fetch", fetchMock);
    for (let i = 0; i < 101; i += 1) await fetchFormats(`https://x/${i}`);
    expect(formatsCache.size).toBe(100);

    const before = fetchMock.mock.calls.length;
    await fetchFormats("https://x/0");
    expect(fetchMock.mock.calls.length).toBe(before + 1);
  });
});

describe("warmDownload", () => {
  it("avisa una sola vez por URL dentro del tope", () => {
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);
    warmDownload("https://y/1");
    warmDownload("https://y/1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("se acota: tras 201 URLs distintas, la primera vuelve a avisar", () => {
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);
    /* Prefijo propio: "y/1" ya lo marco el test de arriba (el Set no se
       limpia entre tests, es el mismo modulo), asi que no puede ser la mas
       vieja de ESTE lote. */
    for (let i = 0; i < 201; i += 1) warmDownload(`https://y-cap/${i}`);
    const before = fetchMock.mock.calls.length;
    warmDownload("https://y-cap/0");
    expect(fetchMock.mock.calls.length).toBe(before + 1);
  });
});

describe("prepareTopStreams", () => {
  const streamable = (url) => ({ extra: { webpage_url: url } });

  it("solo prepara los 2 primeros streameables y una sola vez cada uno", () => {
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);
    const results = [streamable("https://z/1"), streamable("https://z/2"), streamable("https://z/3")];
    prepareTopStreams(results);
    prepareTopStreams(results);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("se acota: tras 201 URLs distintas, la primera vuelve a prepararse", () => {
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);
    /* Prefijo propio por la misma razon que en warmDownload: "z/1" y "z/2" ya
       quedaron marcados por el test de arriba. */
    for (let i = 0; i < 201; i += 1) prepareTopStreams([streamable(`https://z-cap/${i}`)]);
    const before = fetchMock.mock.calls.length;
    prepareTopStreams([streamable("https://z-cap/0")]);
    expect(fetchMock.mock.calls.length).toBe(before + 1);
  });
});
