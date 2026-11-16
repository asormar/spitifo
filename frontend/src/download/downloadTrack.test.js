import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadTrack } from "./downloadTrack.js";
import { queueStore } from "./queueStore.js";
import { verdictStore } from "./verdict.js";

const matched = {
  source: "itunes",
  source_id: "t99",
  title: "Canción 99",
  extra: { webpage_url: "https://www.youtube.com/watch?v=abc", match: "match", real_title: "Real 99" },
};

const response = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });
const queuedItem = (status, extra = {}) => ({
  id: "job99",
  key: "out99",
  track: matched,
  source: "itunes",
  fmt: "m4a",
  media: "audio",
  status,
  progress: status === "done" ? 100 : 40,
  query: "q",
  ...extra,
});

let fetchMock;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  queueStore.applyPayload({ items: [] });
  vi.spyOn(verdictStore, "setFromDownload").mockImplementation(() => {});
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("downloadTrack por la cola del servidor", () => {
  const routeQueue = (payload) => {
    fetchMock.mockImplementation((url, init) => {
      if (String(url).includes("/api/downloads") && init?.method === "POST") {
        return Promise.resolve(response({ items: [{ id: "job99", key: "out99" }] }));
      }
      if (String(url).includes("/api/downloads")) return Promise.resolve(response(payload));
      throw new Error(`fetch inesperado: ${url}`);
    });
  };

  it("encola una sola pista SIN grupo y espera el resultado de done", async () => {
    routeQueue({
      items: [queuedItem("done", { filename: "cancion.m4a", size_mb: 4.2, match: "match", real_title: "Real 99" })],
      running: 0,
      queued: 0,
    });
    const res = await downloadTrack(matched, { query: "q" });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse(post[1].body);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].source).toBe("itunes");
    expect(body.group).toBeUndefined();
    expect(res).toEqual({ filename: "cancion.m4a", size_mb: 4.2, match: "match", real_title: "Real 99" });
  });

  it("un error con muro de verificacion lanza .cookies", async () => {
    routeQueue({
      items: [queuedItem("error", { error: "bot check", error_code: "youtube_bot_check" })],
      running: 0,
      queued: 0,
    });
    await expect(downloadTrack(matched, { query: "q" })).rejects.toMatchObject({
      message: "bot check", cookies: true,
    });
  });

  it("una cancelacion lanza .cancelled y no un error de red", async () => {
    routeQueue({ items: [queuedItem("cancelled")], running: 0, queued: 0 });
    await expect(downloadTrack(matched, { query: "q" })).rejects.toMatchObject({ cancelled: true });
  });

  it("el fallo del POST se propaga como aviso de descarga", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(response({ detail: "fuente apagada" }, false, 403)));
    await expect(downloadTrack(matched, { query: "q" })).rejects.toThrow("fuente apagada");
  });
});

describe("downloadTrack de fuente directa", () => {
  it("sigue bajando en la misma peticion, sin tocar la cola", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ filename: "directa.mp3", size_mb: 2, match: "match", real_title: "X" }))
    );
    const res = await downloadTrack(
      { source: "archive", source_id: "a1", title: "Directa", audio_url: "https://archive.org/x.mp3" },
      { query: "q" }
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/download?");
    expect(res).toEqual({ filename: "directa.mp3", size_mb: 2, match: "match", real_title: "X" });
    expect(verdictStore.setFromDownload).toHaveBeenCalled();
  });
});
