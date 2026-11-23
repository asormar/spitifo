import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeMatchedTracks } from "./albumApi.js";
import { busyResult, consumeWaves, createWaveQueue, fetchTrackMatch, matchState } from "./searchWaves.js";

const fila = (id, extra = {}) => ({
  source: "itunes",
  source_id: id,
  title: `Cancion ${id}`,
  preview_url: `https://audio.example/${id}.m4a`,
  extra,
});

function readerDe(chunks) {
  let i = 0;
  return {
    read: vi.fn(async () => i < chunks.length
      ? { value: new TextEncoder().encode(chunks[i++]), done: false }
      : { value: undefined, done: true }),
    releaseLock: vi.fn(),
  };
}

const ndjson = (chunks) => ({
  ok: true,
  headers: { get: (h) => (h === "content-type" ? "application/x-ndjson" : null) },
  body: { getReader: () => readerDe(chunks) },
});

let fetchMock;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });

describe("matchState", () => {
  it("respeta los cuatro estados del servidor", () => {
    expect(matchState(fila("1", { match_state: "full" }))).toBe("full");
    expect(matchState(fila("1", { match_state: "pending" }))).toBe("pending");
    expect(matchState(fila("1", { match_state: "lazy" }))).toBe("lazy");
    expect(matchState(fila("1", { match_state: "none" }))).toBe("none");
  });

  it("un server viejo sin match_state lo deriva de has_full", () => {
    expect(matchState(fila("1", { has_full: true }))).toBe("full");
    expect(matchState(fila("1", { has_full: false }))).toBe("none");
    expect(matchState(fila("1", {}))).toBe("none");
  });

});

describe("consumeWaves", () => {
  it("entrega catalogo, lotes y done, inclusive con lineas partidas", async () => {
    const cat = { type: "catalog", query: "x", mode: "matched", catalog: "match", count: 2, results: [fila("1"), fila("1"), fila("2")] };
    const lote1 = { type: "tracks", tracks: [fila("1", { match_state: "full" })] };
    const lote2 = { type: "tracks", tracks: [fila("2", { match_state: "none" })] };
    const fin = { type: "done", full: 1, count: 2 };
    const a = `${JSON.stringify(cat)}\n${JSON.stringify(lote1).slice(0, 20)}`;
    const b = `${JSON.stringify(lote1).slice(20)}\n${JSON.stringify(lote2)}\n${JSON.stringify(fin)}`;
    const onCatalog = vi.fn(), onTracks = vi.fn();

    const streamed = await consumeWaves(ndjson([a, b]), { onCatalog, onTracks });

    expect(streamed).toBe(true);
    expect(onCatalog).toHaveBeenCalledTimes(1);
    /* El catalogo conserva el dedupe de siempre y el orden de iTunes. */
    expect(onCatalog.mock.calls[0][0].map((t) => t.source_id)).toEqual(["1", "2"]);
    expect(onTracks).toHaveBeenCalledTimes(2);
    expect(onTracks.mock.calls[0][0][0].extra.match_state).toBe("full");
  });

  it("no toca el body y devuelve false si la respuesta no es NDJSON", async () => {
    const r = {
      ok: true,
      headers: { get: () => "application/json" },
      body: { getReader: vi.fn() },
      json: vi.fn(async () => ({ results: [] })),
    };
    expect(await consumeWaves(r, { onCatalog: vi.fn() })).toBe(false);
    expect(r.body.getReader).not.toHaveBeenCalled();
  });

  it("cierra el reader aunque la ultima linea no tenga salto", async () => {
    const r = ndjson(['{"type":"catalog","results":[]}\n{"type":"done","full":0,"count":0}']);
    const reader = r.body.getReader();
    r.body.getReader = () => reader;
    expect(await consumeWaves(r)).toBe(true);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchTrackMatch", () => {
  it("pide prioridad y devuelve la pista del match", async () => {
    const full = fila("42", { match_state: "full", webpage_url: "https://youtu.be/abcdefghijk" });
    const ac = new AbortController();
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: async () => ({ track: full }) });
    expect(await fetchTrackMatch(fila("42"), ac.signal, true)).toEqual(full);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/search/match/42?priority=1");
    expect(fetchMock.mock.calls[0][1].signal).toBe(ac.signal);
  });

  it("sin prioridad no manda el parametro", async () => {
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: async () => ({ track: fila("7") }) });
    await fetchTrackMatch(fila("7"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/search/match/7");
  });

  it("503 de YouTube cae a 'none' como si no hubiera video", async () => {
    fetchMock.mockResolvedValue({ status: 503, ok: false, json: async () => ({ code: "youtube_busy" }) });
    expect(await fetchTrackMatch(fila("42"))).toEqual(busyResult(fila("42")));
  });
});

describe("createWaveQueue", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("como maximo tres pedidos en vuelo y sin repetir filas", async () => {
    const pending = [];
    const match = vi.fn((t, signal) => new Promise((res) => pending.push({ t, signal, res })));
    const onMatched = vi.fn();
    const q = createWaveQueue({ match, onPending: vi.fn(), onMatched, limit: 3 });
    for (let i = 1; i <= 5; i++) { q.add(fila(String(i))); q.add(fila(String(i))); }
    await flush();

    expect(match).toHaveBeenCalledTimes(3);
    pending[0].res(fila("1", { match_state: "full" }));
    await flush();
    expect(match).toHaveBeenCalledTimes(4);
    expect(onMatched).toHaveBeenCalledTimes(1);
    /* Cada fila se pide una sola vez aunque q.add la reciba dos veces. */
    const pedidos = match.mock.calls.map((c) => c[0].source_id);
    expect(pedidos).toEqual(["1", "2", "3", "4"]);
  });

  it("abort corta los pedidos en vuelo y descarta la espera", async () => {
    const pending = [];
    const match = vi.fn((t, signal) => new Promise((res) => pending.push({ signal, res })));
    const onMatched = vi.fn();
    const q = createWaveQueue({ match, onMatched, limit: 2 });
    for (let i = 1; i <= 4; i++) q.add(fila(String(i)));
    await flush();
    expect(match).toHaveBeenCalledTimes(2);

    q.abort();
    expect(pending.every((p) => p.signal.aborted)).toBe(true);
    pending[0].res(fila("1", { match_state: "full" }));
    await flush();
    expect(match).toHaveBeenCalledTimes(2);
    expect(onMatched).not.toHaveBeenCalled();
    q.add(fila("9"));
    expect(match).toHaveBeenCalledTimes(2);
  });
});

describe("merge en una ola", () => {
  it("reemplaza la fila sin reordenar ni mutar", () => {
    const base = [fila("1"), fila("2"), fila("3")];
    const out = mergeMatchedTracks(base, [fila("2", { match_state: "full" })]);
    expect(out.map((t) => t.source_id)).toEqual(["1", "2", "3"]);
    expect(out[0]).toBe(base[0]);
    expect(out[1].extra.match_state).toBe("full");
    expect(base[1].extra.match_state).toBeUndefined();
  });
});
