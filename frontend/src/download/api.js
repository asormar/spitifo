import { API, errMsg } from "../shared/api.js";

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

export function buildSearchParams(q, mode) {
  const p = new URLSearchParams();
  p.set("q", q);
  p.set("limit", "40");
  p.set("mode", mode);
  if (mode === "ytdlp") p.set("source", "ytdlp");
  return p;
}
export const isTerminal = (j) =>
  j?.status === "done"
  || j?.status === "error"
  || j?.status === "timeout"
  || j?.status === "gone";
/* Sondea el progreso de una descarga yt-dlp hasta que termine.

   Devuelve el estado terminal, o { status: "timeout" } si se venció el tope.
   El tope existe porque el poll no puede colgar el navegador para siempre,
   pero una pista larga (un concierto de 114 min puede tardar 10 min en
   transcodificar) lo revienta sin que el usuario se entere de nada: el toast
   queda girando en "processing" para siempre. Con "timeout" el llamador puede
   al menos avisar que la descarga sigue corriendo en el servidor. */
export async function pollJob(jobId, setJobFor, key, title) {
  for (let i = 0; i < 600; i++) {
    let d;
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(`${API}/download/progress/${jobId}`);
      d = await r.json();
    } catch (e) {
      // El server se cae o la red se corta: sin esto el rechazo sube sin
      // catch y el toast queda girando en "Descargando, N%" para siempre.
      // Se marca como fallido para que ProgressBar lo muestre y el aviso
      // se retire solo con el mismo temporizador que un final normal.
      const failed = { status: "error", error: "se perdió la conexión con el servidor" };
      setJobFor(key, { ...failed, title });
      return failed;
    }
    /* "unknown" es lo que devuelve el backend para un job que ya no existe
       (purgado por el TTL). Seguir sondeando 600 veces un job que no va a
       aparecer es trabajo perdido: se corta aca. */
    if (d.status === "unknown") {
      const gone = { status: "gone", error: "el servidor ya no tiene esta descarga" };
      setJobFor(key, { ...gone, title });
      return gone;
    }
    setJobFor(key, { ...d, title });
    if (d.status === "done" || d.status === "error") return d;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 700));
  }
  // El tope se vencio, pero la descarga puede seguir corriendo en el server:
  // NO se marca como error (eso diria "Falló" y seria falso). Se retira igual
  // el toast, asi que el useEffect de JOB_DISMISS_MS tiene que incluirlo.
  setJobFor(key, { status: "timeout", title });
  return { status: "timeout" };
}
