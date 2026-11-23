import { rowKey } from "../shared/api.js";
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

/* Un resultado una sola vez por fuente+id: yt-dlp a veces devuelve el mismo
   video dos veces y la fila repetida compartiria estado y la clave de React. */
export function uniqueResults(list) {
  const seen = new Set();
  return (list || []).filter((t) => {
    const k = rowKey(t);
    return !seen.has(k) && seen.add(k);
  });
}

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

/* Salida del catalogo de iTunes en Música: "empty" (no hay nada o iTunes no
   tiene la cancion), "weak" (hay resultados pero ninguno es lo pedido), "nofull"
   (los hay, pero ninguno se baja entero: suelen ser versiones de otros) o null
   (todo normal). Otros modos y respuestas viejas sin `catalog` siguen igual.
   "empty" y "weak" los decide iTunes y valen desde el catalogo; "nofull"
   espera a que termine la busqueda (`done`): antes todas las filas estan
   buscando y el 0 de completas no dice nada. */
export function catalogFallback({ mode, catalog, count, full, done = true }) {
  if (mode !== "matched") return null;
  if (!count || catalog === "none") return "empty";
  if (catalog === "weak") return "weak";
  if (full === 0 && done) return "nofull";
  return null;
}

/* La entrada en cascada de la lista: una vez por busqueda, cuando su primera
   lista pinta. Los lotes de la misma busqueda no la repiten (`settled` es la
   ultima busqueda que ya entro). */
export const entranceOn = ({ count, run, settled }) => count > 0 && run !== settled;

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

/* «12 resultados · 5 completas». `full` cuenta los resultados con cancion
   completa disponible (lo que antes se llamaba "descargable"); el marco es de
   escucha, no de descarga. Mientras las filas siguen buscando (`done` falso)
   el recuento no es definitivo y no se dice. */
export function resultsHead(total, full, done = true) {
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const head = n(total, "resultado", "resultados");
  return done ? `${head} · ${n(full, "completa", "completas")}` : head;
}

/* El estado de una fila de descarga vivo aparte (lo usa el shell en el chunk
   de arranque); se reexporta para no tocar a quien lo importaba de aqui. */
export { dlState, dlWaiting, dlText } from "./dlState.js";

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
