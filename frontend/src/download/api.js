import { API, errMsg } from "../shared/api.js";
import { canStream } from "./streamTrack.js";

/* Resoluciones ya pedidas, por URL de video. Vive lo que vive la pestana: el
   menu se puede cerrar y reabrir sin volver a preguntar. Los fallos NO se
   guardan (el usuario tiene que poder reintentar). */
export const formatsCache = new Map();

/* GET /api/formats con el mismo fetch pelado que el resto de la app (mismo
   origen, /api). Devuelve { duration_s, resolutions } ordenado de mayor a menor
   altura: el backend ya lo manda asi, pero ordenar aca cuesta nada y protege
   contra un cambio de contrato. */
export async function fetchFormats(url, signal) {
  const cached = formatsCache.get(url);
  if (cached) return cached;
  const r = await fetch(`${API}/formats?url=${encodeURIComponent(url)}`, { signal });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(errMsg(d, "no se pudieron leer las resoluciones"));
    /* El muro de verificacion llega como 502 {detail, code}. Se propaga para
       que el menu lo trate igual que la descarga (aviso de cookies.txt). */
    err.code = d.code || null;
    throw err;
  }
  const data = {
    duration_s: d.duration_s ?? null,
    resolutions: [...(d.resolutions || [])].sort((a, b) => b.height - a.height),
  };
  formatsCache.set(url, data);
  return data;
}
/* Arma la query contra /api/search respetando los comportamientos reales:
   - YouTube solo filtra con mode=ytdlp&source=ytdlp (mode solo no filtra).
   - mode=matched con un source degrada el emparejamiento, asi que la fuente
     ya no es un filtro del usuario: se deriva siempre del modo. */
/* Avisa al backend de que este video probablemente se va a bajar: adelanta la
   extraccion de yt-dlp (~3 s) y la descarga la reutiliza. Es una pista, no una
   peticion: no se espera, los fallos se ignoran y cada video se avisa una vez
   por pestana (el JSON va sin Content-Type: el backend lo lee igual y asi no
   hay preflight). */
const warmed = new Set();
export function warmDownload(url) {
  if (!url || warmed.has(url)) return;
  warmed.add(url);
  fetch(`${API}/download/warm`, { method: "POST", body: JSON.stringify({ url }) }).catch(() => {});
}

/* Tras buscar, adelanta los 2 primeros resultados que se bajan con yt-dlp (los
   que traen `webpage_url`: en "Música" solo los que tienen archivo completo):
   son los que mas probablemente se toquen. Pocos, para no gastar datos ni red. */
export const warmTopResults = (results) =>
  results
    .map((t) => t.extra?.webpage_url)
    .filter(Boolean)
    .slice(0, 2)
    .forEach(warmDownload);

/* Lo mismo para escuchar: los 2 primeros resultados con version completa
   dejan resuelta su URL de audio (una peticion liviana a YouTube por video),
   asi el primer toque en el boton de reproducir suena sin esperar. */
const prepared = new Set();
export const prepareTopStreams = (results) =>
  results
    .filter(canStream)
    .slice(0, 2)
    .map((t) => t.extra.webpage_url)
    .filter((url) => !prepared.has(url))
    .forEach((url) => {
      prepared.add(url);
      fetch(`${API}/stream/prepare`, { method: "POST", body: JSON.stringify({ url }) }).catch(() => {});
    });

export function buildSearchParams(q, mode) {
  const p = new URLSearchParams();
  p.set("q", q);
  p.set("limit", "40");
  p.set("mode", mode);
  if (mode === "ytdlp") p.set("source", "ytdlp");
  return p;
}

/* Los estados que retiran su aviso. La cola del servidor agrega "cancelled":
   una descarga parada ya no se muestra, pero su fila sigue diciendo
   «Cancelada» en la hoja hasta que el backend la purga. */
export const isTerminal = (j) =>
  j?.status === "done"
  || j?.status === "error"
  || j?.status === "cancelled"
  || j?.status === "timeout"
  || j?.status === "gone";
