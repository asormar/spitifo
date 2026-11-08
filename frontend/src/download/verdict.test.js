import { describe, expect, it, vi } from "vitest";
import { createVerdictStore, libVerdict, libVerdictKey, verdictKey, verdictOf, vText } from "./verdict.js";

const full = { source: "itunes", source_id: "1", extra: { webpage_url: "https://y.test/1" } };
const archive = { source: "archive", source_id: "a1", audio_url: "https://a.test/a1.mp3" };
const preview = { source: "itunes", source_id: "2", preview_url: "https://p.test/2" };
const none = { source: "itunes", source_id: "3" };
const done = (match) => ({ phase: "done", match });

describe("verdictOf: la verdad de cada fila", () => {
  it("con archivo entero y sin comprobar: Sin verificar", () => {
    expect(verdictOf(full, undefined)).toBe("unv");
    expect(verdictOf(archive, null)).toBe("unv");
  });

  it("solo preview: Solo 30 s, haya o no registro", () => {
    expect(verdictOf(preview, undefined)).toBe("p30");
    expect(verdictOf(preview, done("match"))).toBe("p30");
  });

  it("sin preview ni archivo: sin pastilla", () => {
    expect(verdictOf(none, undefined)).toBeNull();
    expect(verdictOf(none, done("match"))).toBeNull();
  });

  it("Coincide, Parecido y No coincide solo salen de un registro hecho", () => {
    expect(verdictOf(full, done("match"))).toBe("match");
    expect(verdictOf(full, done("partial"))).toBe("partial");
    expect(verdictOf(full, done("mismatch"))).toBe("mismatch");
  });

  it("unknown, un registro sin terminar o un fallo se quedan en Sin verificar", () => {
    expect(verdictOf(full, done("unknown"))).toBe("unv");
    expect(verdictOf(full, { phase: "loading" })).toBe("unv");
    expect(verdictOf(full, { phase: "error", error: "x" })).toBe("unv");
    expect(verdictOf(full, done(undefined))).toBe("unv");
  });
});

describe("vText", () => {
  it("distingue lo que nunca se comprobo de lo que no se pudo identificar", () => {
    expect(vText("unv", { untested: true })).toBe("Todavía no se ha comprobado el audio.");
    expect(vText("unv")).toBe("No se pudo identificar el audio.");
  });

  it("el resto de textos", () => {
    expect(vText("match")).toBe("El audio es la canción que buscaste.");
    expect(vText("partial")).toBe("Se parece, pero no es exactamente lo que buscaste.");
    expect(vText("mismatch")).toBe("No es lo que buscabas.");
    expect(vText("p30")).toBe("Solo hay 30 s de esta fuente.");
  });
});

describe("verdictKey", () => {
  it("lleva el resultado y la consulta sin tildes ni mayusculas", () => {
    expect(verdictKey(full, " Nocturne ")).toBe("itunes1|nocturne");
    expect(verdictKey(full, "Canción")).toBe(verdictKey(full, "cancion"));
    expect(verdictKey(full, "a")).not.toBe(verdictKey(full, "b"));
  });
});

const reply = (body, ok = true) => vi.fn(async () => ({ ok, json: async () => body }));

describe("verdictStore", () => {
  it("verificar: carga, termina y guarda el veredicto de las etiquetas", async () => {
    const fetchFn = reply({ extra: { match: "match", real_title: "Nocturne", match_score: 0.92 } });
    const store = createVerdictStore(fetchFn);
    const key = verdictKey(archive, "nocturne");
    const p = store.verify(archive, "nocturne");
    expect(store.get(key)).toEqual({ phase: "loading" });
    await p;
    expect(store.get(key)).toMatchObject({ phase: "done", from: "verify", match: "match", real: "Nocturne", score: 0.92 });
    expect(fetchFn.mock.calls[0][0]).toContain("source=archive&source_id=a1");
  });

  it("una sola peticion en vuelo por clave", async () => {
    const fetchFn = reply({ extra: { match: "partial" } });
    const store = createVerdictStore(fetchFn);
    const a = store.verify(archive, "x");
    const b = store.verify(archive, "x");
    expect(a).toBe(b);
    await a;
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("un fallo queda como error y se puede reintentar", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({ detail: "no se pudo verificar: boom" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ extra: { match: "match" } }) });
    const store = createVerdictStore(fetchFn);
    const key = verdictKey(archive, "x");
    await store.verify(archive, "x");
    expect(store.get(key)).toEqual({ phase: "error", error: "no se pudo verificar: boom" });
    await store.verify(archive, "x");
    expect(store.get(key).match).toBe("match");
  });

  it("una descarga guarda el veredicto del titulo (YouTube) o de las etiquetas", () => {
    const store = createVerdictStore(reply({}));
    store.setFromDownload(full, "q", { match: "mismatch", real_title: "Otro" });
    expect(store.get(verdictKey(full, "q"))).toMatchObject({ match: "mismatch", real: "Otro", by: "video" });
    store.setFromDownload(archive, "q", { match: "match" });
    expect(store.get(verdictKey(archive, "q"))).toMatchObject({ match: "match", real: null, by: "file" });
  });

  it("una descarga pisa un unknown pero nunca una verificacion que identifico el audio", async () => {
    const store = createVerdictStore(reply({ extra: { match: "match", real_title: "T" } }));
    const key = verdictKey(archive, "q");
    store.setFromDownload(archive, "q", { match: "unknown" });
    store.setFromDownload(archive, "q", { match: "partial" });
    expect(store.get(key).match).toBe("partial");
    await store.verify(archive, "q");
    store.setFromDownload(archive, "q", { match: "mismatch" });
    expect(store.get(key)).toMatchObject({ from: "verify", match: "match" });
    /* otra consulta es otra clave */
    store.setFromDownload(archive, "otra", { match: "mismatch" });
    expect(store.get(verdictKey(archive, "otra")).match).toBe("mismatch");
  });

  it("solo cambia la identidad del registro tocado y avisa a los suscriptores", () => {
    const store = createVerdictStore(reply({}));
    const spy = vi.fn();
    const off = store.subscribe(spy);
    store.setFromDownload(full, "a", { match: "match" });
    const first = store.get(verdictKey(full, "a"));
    store.setFromDownload(archive, "b", { match: "match" });
    expect(store.get(verdictKey(full, "a"))).toBe(first);
    expect(spy).toHaveBeenCalledTimes(2);
    off();
    store.setFromDownload(archive, "c", { match: "match" });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("archivos recien bajados", () => {
  it("sin registro no hay pastilla: la ausencia nunca es Coincide", () => {
    expect(libVerdict(undefined)).toBeNull();
    expect(libVerdict({ phase: "loading" })).toBeNull();
  });

  it("con registro: el veredicto, o Sin verificar si no se pudo identificar", () => {
    expect(libVerdict({ phase: "done", match: "match" })).toBe("match");
    expect(libVerdict({ phase: "done", match: "mismatch" })).toBe("mismatch");
    expect(libVerdict({ phase: "done", match: "unknown" })).toBe("unv");
  });

  it("la descarga deja el registro tambien bajo la clave del archivo nuevo", () => {
    const store = createVerdictStore(reply({}));
    store.setFromDownload(full, "q", { match: "partial", real_title: "Otro", libKey: "Artista/Artista - Tema.mp3" });
    expect(store.get(libVerdictKey("Artista/Artista - Tema.mp3"))).toMatchObject({ match: "partial", real: "Otro" });
    expect(libVerdictKey("a/b.mp3")).toBe("lib|a/b.mp3");
  });
});
