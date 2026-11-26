import { describe, expect, it, vi } from "vitest";
import { createArt } from "./art.js";

const record = (source = "itunes") => ({
  key: ".art/big.jpg",
  small_key: ".art/big.s.jpg",
  source,
});

const json = (data, ok = true) => ({
  ok,
  json: async () => data,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("art store", () => {
  it("carga una sola vez el mapa de GET /api/art", async () => {
    const fetchFn = vi.fn(async () => json({ art: { "album:x": record() } }));
    const store = createArt({ fetchFn });
    await store.load();
    expect(fetchFn).toHaveBeenCalledWith("/api/art");
    expect(store.getState().byTarget.get("album:x")).toEqual(record());
    await store.load();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await store.load(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("avisa a los suscriptores al cargar", async () => {
    const store = createArt({ fetchFn: async () => json({ art: {} }) });
    const fn = vi.fn();
    store.subscribe(fn);
    await store.load();
    expect(fn).toHaveBeenCalled();
  });

  it("upload es optimista y deshace si falla", async () => {
    let ok = false;
    const fetchFn = vi.fn(async () => (ok ? json({ target: "song:a", ...record("upload") }) : json({}, false)));
    const store = createArt({ fetchFn });
    await store.load();
    const p = store.upload("song:a", "BIG", "SMALL", { url: "blob:big", smallUrl: "blob:small" });
    expect(store.getState().byTarget.get("song:a").pending).toBe(true);
    expect(await p).toBe(false);
    expect(store.getState().byTarget.has("song:a")).toBe(false);

    ok = true;
    expect(await store.upload("song:a", "BIG", "SMALL", { url: "blob:big" })).toBe(true);
    /* Sin `url`: el data: URL de la subida (unos 2.7 MB en la app real) no se
       queda en memoria para siempre, solo el registro confirmado. */
    expect(store.getState().byTarget.get("song:a")).toEqual(record("upload"));
    expect(JSON.parse(fetchFn.mock.calls.at(-1)[1].body)).toEqual({
      target: "song:a",
      image: "BIG",
      small: "SMALL",
    });
  });

  it("from-url SI conserva la URL confirmada (la usa la hoja para la marca Actual)", async () => {
    const fetchFn = vi.fn(async () => json({ target: "artist:x", ...record("youtube") }));
    const store = createArt({ fetchFn });
    const ok = await store.fromUrl("artist:x", "https://i.ytimg.com/vi/x/hqdefault.jpg", "youtube");
    expect(ok).toBe(true);
    expect(store.getState().byTarget.get("artist:x")).toEqual({
      ...record("youtube"),
      url: "https://i.ytimg.com/vi/x/hqdefault.jpg",
    });
  });

  it("from-url manda la fuente detectada y conserva la URL", async () => {
    const fetchFn = vi.fn(async () => json({ target: "artist:x", ...record("youtube") }));
    const store = createArt({ fetchFn });
    const ok = await store.fromUrl("artist:x", "https://i.ytimg.com/vi/x/hqdefault.jpg", "youtube");
    expect(ok).toBe(true);
    expect(store.getState().byTarget.get("artist:x").source).toBe("youtube");
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({
      target: "artist:x",
      url: "https://i.ytimg.com/vi/x/hqdefault.jpg",
      source: "youtube",
    });
  });

  it("reset aplica el mapa que devuelve el servidor", async () => {
    const fetchFn = vi.fn(async () => json({ art: {} }));
    const store = createArt({ fetchFn });
    await store.load();
    const before = new Map(store.getState().byTarget);
    before.set("album:x", record());
    expect(await store.reset("album:x")).toBe(true);
    expect(store.getState().byTarget.size).toBe(0);
    expect(JSON.parse(fetchFn.mock.calls.at(-1)[1].body)).toEqual({ target: "album:x" });
  });

  it("una recarga forzada con el mismo contenido conserva el Map (P-render-main-thread-7)", async () => {
    const fetchFn = vi.fn(async () => json({ art: { "album:x": record() } }));
    const store = createArt({ fetchFn });
    await store.load();
    const before = store.getState().byTarget;
    await store.load(true);
    expect(store.getState().byTarget).toBe(before);
  });

  it("una recarga forzada con una foto nueva SI cambia el Map", async () => {
    let withCover = false;
    const fetchFn = vi.fn(async () =>
      json({ art: withCover ? { "album:x": record() } : {} })
    );
    const store = createArt({ fetchFn });
    await store.load();
    const before = store.getState().byTarget;
    withCover = true;
    await store.load(true);
    expect(store.getState().byTarget).not.toBe(before);
    expect(store.getState().byTarget.get("album:x")).toEqual(record());
  });

  it("un error de red no deja la foto optimista colgada", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network");
    });
    const store = createArt({ fetchFn });
    expect(await store.fromUrl("song:x", "https://i.ytimg.com/vi/x/hqdefault.jpg", "youtube")).toBe(false);
    expect(store.getState().byTarget.size).toBe(0);
    await flush();
  });
});
