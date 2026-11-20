import { describe, expect, it, vi } from "vitest";
import { createSaved } from "./saved.js";

const record = (id = "yt:dQw4w9WgXcQ") => ({
  id, title: "Tema", artist: "Artista", album: null, duration: 200,
  artwork_url: null, source: "youtube", source_id: id.slice(3),
  itunes: {}, file_key: null,
});
const reply = (songs) => ({ ok: true, json: async () => ({ songs }) });

describe("saved store", () => {
  it("loads GET /api/saved once and indexes by id", async () => {
    const fetchFn = vi.fn(async () => reply([record()]));
    const store = createSaved({ fetchFn });
    const seen = [];
    const off = store.subscribe(() => seen.push(store.getState().byId));
    await Promise.all([store.load(), store.load()]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.getState().byId.get(record().id)).toEqual(record());
    expect(seen).toHaveLength(1);
    off();
  });

  it("puts the song before adding it and keeps the optimistic row", async () => {
    const saved = record();
    const fetchFn = vi.fn(async () => reply([saved]));
    const store = createSaved({ fetchFn });
    expect(await store.save(saved)).toBe(true);
    expect(fetchFn.mock.calls[0][0]).toBe("/api/saved");
    expect(fetchFn.mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).songs).toEqual([saved]);
    expect(store.getState().byId.get(saved.id).title).toBe("Tema");
  });

  it("rolls the optimistic row back when the PUT fails", async () => {
    const store = createSaved({ fetchFn: async () => ({ ok: false }) });
    expect(store.getState().byId.size).toBe(0);
    expect(await store.save(record())).toBe(false);
    expect(store.getState().byId.size).toBe(0);
  });

  it("hides and restores a record with the undo window", async () => {
    const store = createSaved({ fetchFn: async () => reply([record()]) });
    await store.load();
    store.hide([record().id]);
    expect(store.getState().byId.size).toBe(0);
    store.restore([record()]);
    expect(store.getState().byId.get(record().id)).toEqual(record());
  });

  it("a reload does not bring back a hidden id", async () => {
    const fetchFn = vi.fn(async () => reply([record()]));
    const store = createSaved({ fetchFn });
    await store.load(false, (songs) => songs.filter((s) => s.id !== record().id));
    expect(store.getState().byId.size).toBe(0);
  });

  it("remove posts the ids and drops them only on success", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true }));
    const store = createSaved({ fetchFn });
    await store.load();
    expect(await store.remove([record().id])).toBe(true);
    expect(fetchFn.mock.calls.at(-1)[0]).toBe("/api/saved/remove");
    expect(JSON.parse(fetchFn.mock.calls.at(-1)[1].body)).toEqual({ ids: [record().id] });
    expect(store.getState().byId.size).toBe(0);

    const failing = createSaved({ fetchFn: async (url) =>
      url === "/api/saved" ? reply([record()]) : { ok: false } });
    await failing.load();
    expect(await failing.remove([record().id])).toBe(false);
    expect(failing.getState().byId.size).toBe(1);
  });
});
