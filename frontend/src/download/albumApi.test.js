import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeMatchedTracks, streamAlbumMatch } from "./albumApi.js";

const fila = (id, has_full = null) => ({
  source: "itunes",
  source_id: id,
  title: `Cancion ${id}`,
  extra: { disc_number: 1, track_number: Number(id), has_full },
});

function readerDe(chunks) {
  let i = 0;
  return {
    read: vi.fn(async () =>
      i < chunks.length
        ? { value: new TextEncoder().encode(chunks[i++]), done: false }
        : { value: undefined, done: true }
    ),
    releaseLock: vi.fn(),
    cancel: vi.fn(async () => {}),
  };
}

const respuestaStream = (chunks, body) => ({
  ok: true,
  status: 200,
  body: body === undefined ? { getReader: () => readerDe(chunks) } : body,
});

let fetchMock;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("parser NDJSON del stream", () => {
  it("junta una linea partida en dos chunks", async () => {
    const a = '{"type":"album","album":{"title":"Meteora"},"ytdlp":true}\n{"type":"tr';
    const b = 'acks","tracks":[{"source_id":"t1"}]}\n{"type":"done","full":1,"tracks":[{"source_id":"t1"}]}\n';
    fetchMock.mockResolvedValue(respuestaStream([a, b]));
    const onTracks = vi.fn();
    const final = await streamAlbumMatch(999, { onTracks });

    expect(onTracks).toHaveBeenCalledTimes(1);
    expect(onTracks.mock.calls[0][0][0].source_id).toBe("t1");
    expect(final).toEqual({
      album: { title: "Meteora" },
      ytdlp: true,
      full: 1,
      tracks: [{ source_id: "t1" }],
    });
  });

  it("acepta el ultimo objeto sin salto de linea final", async () => {
    const lineas = '{"type":"album","album":{},"ytdlp":false}\n' +
      '{"type":"done","full":0,"tracks":[]}';
    fetchMock.mockResolvedValue(respuestaStream([lineas]));
    const final = await streamAlbumMatch(999);
    expect(final).toEqual({ album: {}, ytdlp: false, full: 0, tracks: [] });
  });
});

describe("streamAlbumMatch", () => {
  const lotes = [
    '{"type":"album","album":{"id":999},"ytdlp":true}\n' +
      '{"type":"tracks","tracks":[{"source_id":"t1","extra":{"has_full":true}}]}\n',
    '{"type":"tracks","tracks":[{"source_id":"t2","extra":{"has_full":true}}]}\n' +
      '{"type":"done","full":2,"tracks":[{"source_id":"t1"},{"source_id":"t2"}]}\n',
  ];

  it("avisa cada lote y resuelve con el payload final", async () => {
    fetchMock.mockResolvedValue(respuestaStream(lotes));
    const onTracks = vi.fn();
    const final = await streamAlbumMatch(999, { onTracks });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/album/999/match?stream=1");
    expect(onTracks).toHaveBeenCalledTimes(2);
    expect(onTracks.mock.calls[0][0][0].source_id).toBe("t1");
    expect(onTracks.mock.calls[1][0][0].source_id).toBe("t2");
    expect(final).toEqual({
      album: { id: 999 }, ytdlp: true, full: 2,
      tracks: [{ source_id: "t1" }, { source_id: "t2" }],
    });
    expect(final.full).toBe(2);
    expect(final.tracks.map((t) => t.source_id)).toEqual(["t1", "t2"]);
  });

  it("cae al pedido normal si no hay ReadableStream", async () => {
    const payload = { album: {}, tracks: [], ytdlp: false, full: 0 };
    fetchMock
      .mockResolvedValueOnce(respuestaStream([], null))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => payload });

    expect(await streamAlbumMatch(999)).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/album/999/match");
  });

  it("cae al pedido normal si el stream termina sin done", async () => {
    const payload = { album: {}, tracks: [], ytdlp: true, full: 0 };
    fetchMock
      .mockResolvedValueOnce(respuestaStream(['{"type":"album","album":{}}\n']))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => payload });

    expect(await streamAlbumMatch(999)).toEqual(payload);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/album/999/match");
  });

  it("propaga el error del servidor", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ detail: "iTunes no respondio" }),
    });
    await expect(streamAlbumMatch(999)).rejects.toThrow("iTunes no respondio");
  });
});

describe("mergeMatchedTracks", () => {
  it("reemplaza la fila matcheada sin cambiar el orden", () => {
    const base = [fila("1"), fila("2"), fila("3")];
    const out = mergeMatchedTracks(base, [fila("2", true)]);

    expect(out.map((t) => t.source_id)).toEqual(["1", "2", "3"]);
    expect(out[0]).toBe(base[0]);
    expect(out[1].extra.has_full).toBe(true);
    expect(out[2]).toBe(base[2]);
    expect(base[1].extra.has_full).toBeNull();  // no muta la entrada
  });

  it("apaga varias filas a la vez y agrega las que no estaban", () => {
    const out = mergeMatchedTracks(
      [fila("1"), fila("2")],
      [fila("3", true), fila("1", true)]
    );
    expect(out.map((t) => t.source_id)).toEqual(["1", "2", "3"]);
    expect(out[0].extra.has_full).toBe(true);
    expect(out[1].extra.has_full).toBeNull();
  });

  it("sin actualizaciones devuelve la misma lista", () => {
    const base = [fila("1")];
    expect(mergeMatchedTracks(base, [])).toBe(base);
  });
});
