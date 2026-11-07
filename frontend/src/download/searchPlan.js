import { fmtSize } from "../shared/format.js";
import { MODE_IDS, isYouTubeUrl, trackState } from "./constants.js";

/* ---------------------------------------------------------------------------
   PLAN DE LA BUSQUEDA

   Las decisiones de Buscar sin React ni DOM, para probarlas en Node: que se
   lanza al dar Enter, cuando se repite una busqueda, como se lee y se escribe la
   URL, que se cuenta de los resultados y que aviso sale de una descarga.
   ------------------------------------------------------------------------- */

const DEFAULT_MODE = "matched";
/* Menos de dos letras no filtran nada util: la biblioteca no se consulta. */
const LIBRARY_MIN = 2;

export const searchSig = (mode, text) => `${mode}|${text}`;

/* Lo que hace Enter: el texto recortado y el modo con que se busca. Un enlace
   de YouTube fuerza ese modo (es el unico que lo entiende). null = no hay nada
   que buscar. */
export function planSubmit({ q, mode }) {
  const text = String(q ?? "").trim();
  if (!text) return null;
  return { text, mode: isYouTubeUrl(text) ? "ytdlp" : mode };
}

/* Cambiar de modo DESPUES de buscar vuelve a consultar; antes de buscar no. La
   firma evita el bucle: si la peticion de este modo ya se hizo, no se repite. */
export function shouldResync({ searched, query, mode, lastSig }) {
  if (!searched || !query) return false;
  return searchSig(mode, query) !== lastSig;
}

/* El texto con que se consulta la biblioteca mientras se escribe, o null. */
export function libraryQuery(q) {
  const t = String(q ?? "").trim();
  return t.length >= LIBRARY_MIN ? t : null;
}

/* --- URL: ?q= y ?mode= ------------------------------------------------------- */

/* Los links viejos con ?src=ytdlp equivalen al modo YouTube; cualquier otra
   fuente ya no se puede filtrar. */
export function parseUrl(search) {
  const p = new URLSearchParams(search || "");
  const m = p.get("mode");
  const mode = m && MODE_IDS.includes(m) ? m : p.get("src") === "ytdlp" ? "ytdlp" : DEFAULT_MODE;
  return { q: p.get("q") || "", mode };
}

/* Solo se tocan `mode` y `q`: `view` y cualquier otro parametro siguen donde
   estaban. Sin consulta, `q` se quita. "" = sin parametros. */
export function urlFor(search, { mode, query }) {
  const p = new URLSearchParams(search || "");
  if (mode) p.set("mode", mode);
  else p.delete("mode");
  if (query) p.set("q", query);
  else p.delete("q");
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

/* --- Resultados ----------------------------------------------------------------- */

export function summarize(results, filter) {
  const full = results.filter((t) => trackState(t) === "full");
  return {
    total: results.length,
    full: full.length,
    shown: filter === "full" ? full : results,
    filterEmpty: filter === "full" && results.length > 0 && full.length === 0,
  };
}

/* «12 resultados para «q», 5 descargables». */
export function resultsHead(total, full, query) {
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  return `${n(total, "resultado", "resultados")} para «${query}», ${n(full, "descargable", "descargables")}`;
}

/* --- La descarga de una fila ---------------------------------------------------
   `job` es el del jobsStore (solo yt-dlp tiene); `busy` vale desde que se pulsa
   hasta que termina, tambien en las fuentes directas (sin job). Un job en error
   se ve como reposo: el aviso ya dice que fallo. */
export function dlState({ busy = false, job, downloaded = false }) {
  const s = job?.status;
  if (s === "error") return { id: "err", pct: 0 };
  if (s === "pending") return { id: "queued", pct: 0 };
  if (s === "downloading") {
    return { id: "down", pct: Math.min(100, Math.max(0, Math.round(job.progress || 0))) };
  }
  if (s === "processing") return { id: "proc", pct: 100 };
  if (s === "done" || (!busy && downloaded)) return { id: "done", pct: 100 };
  return busy ? { id: "direct", pct: 0 } : { id: "idle", pct: 0 };
}

/* El texto del boton de la ficha y, salvo en reposo y listo, el nombre accesible
   de la fila. */
export function dlText({ id, pct }) {
  return {
    idle: "Descargar",
    err: "Falló la descarga",
    queued: "En cola",
    down: `Descargando, ${pct} %`,
    proc: "Procesando el archivo…",
    direct: "Descargando…",
    done: "Descargado",
  }[id];
}

/* --- Avisos de la descarga --------------------------------------------------------
   Un solo aviso a la vez: { tone: "ok" | "warn" | "err", text, sub?, cookies?,
   key? }. `cookies`: el fallo fue el muro de verificacion de YouTube y el aviso
   ofrece importar cookies.txt. */

const STILL_RUNNING =
  "Esta descarga sigue corriendo en el servidor y va a aparecer en tu biblioteca cuando termine.";

/* La descarga termino. "mismatch" y "unknown" avisan a proposito: el primero
   dice que el archivo no es lo buscado; el segundo, que nadie pudo leer de donde
   viene el audio ("no se pudo verificar" es mas honesto que un visto bueno que
   nadie emitio). */
export function noticeFromSuccess({ filename, size_mb: size, match, real_title: real }, query) {
  if (match === "mismatch" || match === "unknown") {
    const where = real ? `en el archivo dice «${real}»` : "no se pudo verificar de dónde viene el audio";
    return { tone: "warn", text: `Ojo: ${where} y tú buscaste «${query}».`, key: `w:${filename}` };
  }
  return {
    tone: "ok",
    text: `${filename} está en tu biblioteca${size ? ` (${fmtSize(size)})` : ""}.`,
    sub: match === "match" && real ? `Verificado: «${real}»` : undefined,
    key: filename,
  };
}

export const noticeFromError = (text, cookies = false) => ({ tone: "err", text, cookies });

/* El job termino mal, o dejo de poder seguirse (tope de espera, ya no existe en
   el servidor: eso no es un fallo, la descarga puede seguir corriendo). */
export function noticeFromJob(finished) {
  if (finished.status === "timeout" || finished.status === "gone") {
    return { tone: "warn", text: finished.error || STILL_RUNNING };
  }
  return noticeFromError(finished.error || "la descarga falló", finished.error_code === "youtube_bot_check");
}
