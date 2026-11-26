import { describe, expect, it, vi } from "vitest";

const json = (status, data) => ({
  ok: status < 400,
  status,
  json: async () => data,
});

describe("fetchArtist", () => {
  it("pide el detalle una sola vez por sesion: la segunda apertura no repite el pedido", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async () => json(200, { id: "1", name: "Artista" }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchArtist } = await import("./artistApi.js");

    const a = await fetchArtist("1");
    const b = await fetchArtist("1");
    expect(a).toEqual({ id: "1", name: "Artista" });
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("un fallo no deja la cache colgada: la siguiente visita reintenta", async () => {
    vi.resetModules();
    let ok = false;
    const fetchMock = vi.fn(async () => (ok ? json(200, { id: "2" }) : json(502, {})));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchArtist } = await import("./artistApi.js");

    await expect(fetchArtist("2")).rejects.toThrow();
    ok = true;
    await expect(fetchArtist("2")).resolves.toEqual({ id: "2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("dos ids distintos no comparten pedido", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async (url) => json(200, { url }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchArtist } = await import("./artistApi.js");

    await fetchArtist("a");
    await fetchArtist("b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});
