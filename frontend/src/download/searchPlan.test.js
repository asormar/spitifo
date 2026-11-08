import { describe, expect, it } from "vitest";
import {
  dlState,
  dlText,
  libraryQuery,
  noticeFromError,
  noticeFromJob,
  noticeFromSuccess,
  parseUrl,
  planSubmit,
  resultsHead,
  searchSig,
  shouldResync,
  summarize,
  uniqueResults,
  urlFor,
} from "./searchPlan.js";

const full = (id) => ({ source: "itunes", source_id: id, extra: { webpage_url: "https://y.test/" + id } });
const preview = (id) => ({ source: "itunes", source_id: id, preview_url: "https://p.test/" + id });
const none = (id) => ({ source: "itunes", source_id: id });

describe("planSubmit", () => {
  it("recorta el texto y conserva el modo", () => {
    expect(planSubmit({ q: "  chopin nocturne ", mode: "sources" })).toEqual({
      text: "chopin nocturne",
      mode: "sources",
    });
  });

  it("vacio o solo espacios no hace nada", () => {
    expect(planSubmit({ q: "", mode: "matched" })).toBeNull();
    expect(planSubmit({ q: "   ", mode: "matched" })).toBeNull();
    expect(planSubmit({ q: null, mode: "matched" })).toBeNull();
  });

  it("un enlace de YouTube fuerza el modo YouTube", () => {
    expect(planSubmit({ q: "https://youtu.be/abc123", mode: "matched" }).mode).toBe("ytdlp");
    expect(planSubmit({ q: "www.youtube.com/watch?v=abc", mode: "sources" }).mode).toBe("ytdlp");
  });

  it("texto normal en modo YouTube se queda en YouTube", () => {
    expect(planSubmit({ q: "radiohead creep", mode: "ytdlp" }).mode).toBe("ytdlp");
  });
});

describe("shouldResync", () => {
  const base = { searched: true, query: "creep", mode: "matched", lastSig: searchSig("matched", "creep") };

  it("no repite si la firma ya es la de la peticion hecha", () => {
    expect(shouldResync(base)).toBe(false);
  });

  it("cambiar de modo despues de buscar vuelve a consultar", () => {
    expect(shouldResync({ ...base, mode: "ytdlp" })).toBe(true);
  });

  it("nunca antes de haber buscado", () => {
    expect(shouldResync({ ...base, searched: false, mode: "ytdlp" })).toBe(false);
    expect(shouldResync({ ...base, query: "", mode: "ytdlp" })).toBe(false);
  });

  it("sin bucle: tras repetir, la nueva firma ya coincide", () => {
    const next = { ...base, mode: "ytdlp" };
    expect(shouldResync(next)).toBe(true);
    expect(shouldResync({ ...next, lastSig: searchSig(next.mode, next.query) })).toBe(false);
  });
});

describe("libraryQuery", () => {
  it("menos de 2 caracteres no consulta", () => {
    expect(libraryQuery("")).toBeNull();
    expect(libraryQuery("n")).toBeNull();
    expect(libraryQuery(" a ")).toBeNull();
    expect(libraryQuery(null)).toBeNull();
  });

  it("desde 2 caracteres devuelve el texto recortado, con acentos y mayusculas", () => {
    expect(libraryQuery("ni")).toBe("ni");
    expect(libraryQuery("  Nocturne Él ")).toBe("Nocturne Él");
  });
});

describe("parseUrl / urlFor", () => {
  it("lee q y mode", () => {
    expect(parseUrl("?q=chopin&mode=itunes")).toEqual({ q: "chopin", mode: "matched" });
    expect(parseUrl("?q=chopin&mode=sources")).toEqual({ q: "chopin", mode: "sources" });
  });

  it("sin nada, modo Musica y sin consulta", () => {
    expect(parseUrl("")).toEqual({ q: "", mode: "matched" });
    expect(parseUrl(undefined)).toEqual({ q: "", mode: "matched" });
  });

  it("conserva el ?src=ytdlp de los enlaces viejos", () => {
    expect(parseUrl("?q=x&src=ytdlp").mode).toBe("ytdlp");
    expect(parseUrl("?q=x&src=otro").mode).toBe("matched");
    /* un mode valido gana al src */
    expect(parseUrl("?q=x&mode=sources&src=ytdlp").mode).toBe("sources");
  });

  it("escribe mode y q y respeta view y lo demas", () => {
    expect(urlFor("?view=search&x=1", { mode: "ytdlp", query: "creep" })).toBe(
      "?view=search&x=1&mode=ytdlp&q=creep"
    );
  });

  it("sin consulta quita q pero deja view y mode", () => {
    expect(urlFor("?view=search&mode=sources&q=jazz", { mode: "sources", query: "" })).toBe(
      "?view=search&mode=sources"
    );
  });

  it("sin nada que escribir devuelve vacio", () => {
    expect(urlFor("?q=a", { mode: "", query: "" })).toBe("");
  });

  it("escapa el texto", () => {
    expect(urlFor("", { mode: "matched", query: "a&b c" })).toBe("?mode=matched&q=a%26b+c");
  });
});

describe("summarize", () => {
  const results = [full("1"), preview("2"), none("3"), full("4")];

  it("cuenta los descargables y muestra todo por defecto", () => {
    const s = summarize(results, "all");
    expect(s.total).toBe(4);
    expect(s.full).toBe(2);
    expect(s.shown).toHaveLength(4);
    expect(s.filterEmpty).toBe(false);
  });

  it("el filtro deja solo la descarga completa", () => {
    const s = summarize(results, "full");
    expect(s.shown.map((t) => t.source_id)).toEqual(["1", "4"]);
  });

  it("filtro vacio: hay resultados pero ninguno completo", () => {
    const s = summarize([preview("1"), none("2")], "full");
    expect(s.shown).toEqual([]);
    expect(s.filterEmpty).toBe(true);
  });

  it("sin resultados no es filtro vacio", () => {
    expect(summarize([], "full").filterEmpty).toBe(false);
  });
});

describe("avisos de la descarga", () => {
  it("ok con y sin tamano", () => {
    expect(
      noticeFromSuccess({ filename: "a.mp3", size_mb: 4.2, match: "match", real_title: "Creep" }, "creep")
    ).toEqual({
      tone: "ok",
      text: "a.mp3 está en tu biblioteca (4.2 MB).",
      sub: "Verificado: «Creep»",
      key: "a.mp3",
    });
    const plain = noticeFromSuccess({ filename: "b.mp3" }, "creep");
    expect(plain.tone).toBe("ok");
    expect(plain.text).toBe("b.mp3 está en tu biblioteca.");
    expect(plain.sub).toBeUndefined();
  });

  it("mismatch avisa con el titulo real y las comillas nuevas", () => {
    const n = noticeFromSuccess({ filename: "a.mp3", match: "mismatch", real_title: "Otra" }, "creep");
    expect(n.tone).toBe("warn");
    expect(n.text).toBe("Ojo: en el archivo dice «Otra» y tú buscaste «creep».");
  });

  it("unknown avisa que no se pudo verificar, nunca da un visto bueno", () => {
    const n = noticeFromSuccess({ filename: "a.mp3", match: "unknown" }, "creep");
    expect(n.tone).toBe("warn");
    expect(n.text).toBe("Ojo: no se pudo verificar de dónde viene el audio y tú buscaste «creep».");
  });

  it("partial no avisa: es un ok sin la linea Verificado", () => {
    const n = noticeFromSuccess({ filename: "a.mp3", match: "partial", real_title: "X" }, "creep");
    expect(n.tone).toBe("ok");
    expect(n.sub).toBeUndefined();
  });

  it("timeout y gone son avisos, no errores", () => {
    expect(noticeFromJob({ status: "timeout" }).tone).toBe("warn");
    expect(noticeFromJob({ status: "timeout" }).text).toMatch(/sigue corriendo/);
    const gone = noticeFromJob({ status: "gone", error: "el servidor ya no tiene esta descarga" });
    expect(gone).toEqual({ tone: "warn", text: "el servidor ya no tiene esta descarga" });
  });

  it("el muro de YouTube es un error con salida a las cookies", () => {
    expect(noticeFromJob({ status: "error", error: "bot", error_code: "youtube_bot_check" })).toEqual({
      tone: "err",
      text: "bot",
      cookies: true,
    });
    expect(noticeFromJob({ status: "error" })).toEqual({ tone: "err", text: "la descarga falló", cookies: false });
    expect(noticeFromError("x")).toEqual({ tone: "err", text: "x", cookies: false });
  });
});

describe("resultsHead", () => {
  it("cuenta resultados y descargables, con singular", () => {
    expect(resultsHead(12, 5, "creep")).toBe("12 resultados para «creep», 5 descargables");
    expect(resultsHead(1, 1, "creep")).toBe("1 resultado para «creep», 1 descargable");
    expect(resultsHead(3, 0, "x")).toBe("3 resultados para «x», 0 descargables");
  });
});

describe("dlState", () => {
  it("reposo, y hecho en esta sesion", () => {
    expect(dlState({})).toEqual({ id: "idle", pct: 0 });
    expect(dlState({ downloaded: true })).toEqual({ id: "done", pct: 100 });
  });

  it("los pasos de un job de yt-dlp", () => {
    const job = (status, progress) => ({ status, progress });
    expect(dlState({ busy: true, job: job("pending") }).id).toBe("queued");
    expect(dlState({ busy: true, job: job("downloading", 41.6) })).toEqual({ id: "down", pct: 42 });
    expect(dlState({ busy: true, job: job("processing", 100) }).id).toBe("proc");
    expect(dlState({ busy: true, job: job("done", 100) }).id).toBe("done");
  });

  it("el porcentaje se mantiene entre 0 y 100", () => {
    expect(dlState({ busy: true, job: { status: "downloading", progress: 140 } }).pct).toBe(100);
    expect(dlState({ busy: true, job: { status: "downloading", progress: -3 } }).pct).toBe(0);
    expect(dlState({ busy: true, job: { status: "downloading" } }).pct).toBe(0);
  });

  it("una fuente directa (sin job) ocupada es indeterminada", () => {
    expect(dlState({ busy: true })).toEqual({ id: "direct", pct: 0 });
  });

  it("volver a bajar algo ya bajado muestra el progreso, no el check", () => {
    expect(dlState({ busy: true, downloaded: true, job: { status: "pending" } }).id).toBe("queued");
    expect(dlState({ busy: true, downloaded: true }).id).toBe("direct");
  });

  it("un job en error se ve como reposo con su texto", () => {
    const s = dlState({ job: { status: "error" } });
    expect(s.id).toBe("err");
    expect(dlText(s)).toBe("Falló la descarga");
  });

  it("los textos del boton", () => {
    expect(dlText({ id: "idle", pct: 0 })).toBe("Descargar");
    expect(dlText({ id: "down", pct: 62 })).toBe("Descargando, 62 %");
    expect(dlText({ id: "proc", pct: 100 })).toBe("Procesando el archivo…");
    expect(dlText({ id: "done", pct: 100 })).toBe("Descargado");
  });
});

describe("uniqueResults", () => {
  it("quita el resultado repetido y conserva el orden", () => {
    const a = full("a");
    const b = { source: "ytdlp", source_id: "a" };
    const out = uniqueResults([a, b, { ...a }, full("c")]);
    expect(out).toEqual([a, b, full("c")]);
  });

  it("acepta una lista ausente", () => {
    expect(uniqueResults(undefined)).toEqual([]);
  });
});
