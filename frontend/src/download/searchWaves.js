import { API, rowKey } from "../shared/api.js";
import { leerNdjson, mergeMatchedTracks } from "./albumApi.js";
import { uniqueResults } from "./searchPlan.js";

/* ---------------------------------------------------------------------------
   OLAS DE BUSQUEDA (parte pura)

   Catalogo y lotes de pistas llegan por NDJSON. Todo lo que no es React vive
   aca: el estado de cada fila, el lector del stream, el pedido de una pista y
   la cola que limita cuantas busquedas "lazy" vuelan a la vez. Modulo sin DOM
   (fetch se inyecta por el global, como en el resto de la app): se prueba en
   Node. Los comentarios de bloque van sin tildes; las etiquetas de la UI no.
   ------------------------------------------------------------------------- */

/* El servidor nuevo manda match_state; el viejo solo has_full. Un mismo
   nombre para los dos, asi la fila no necesita saber de donde vino. */
export function matchState(t) {
  const x = t?.extra;
  if (!x) return "none";
  const s = x.match_state;
  return s === "full" || s === "pending" || s === "lazy" || s === "none"
    ? s : x.has_full ? "full" : "none";
}

/* YouTube ocupado (503) es "no hay entera", no un error: la fila cae al
   avance de 30 s como si el match hubiera terminado sin video. */
export const busyResult = (t) => ({
  ...t,
  extra: { ...t.extra, match_state: "none" },
});

/* GET /api/search/match/{id}[?priority=1]. El id es el source_id de iTunes
   (_track_key en main.py). Un toque pide priority para adelantarse. Cualquier
   fallo (incluido el 503 de YouTube ocupado) cae a "none": la fila suena el
   avance de 30 s en vez de quedar colgada. */
export async function fetchTrackMatch(t, signal, priority = false) {
  const r = await fetch(
    `${API}/search/match/${t?.source_id || ""}${priority ? "?priority=1" : ""}`,
    { signal }
  );
  const d = r.ok ? await r.json().catch(() => ({})) : {};
  return d?.track || busyResult(t);
}

/* Lee el NDJSON de /api/search?stream=1. Devuelve false cuando la respuesta
   no es un stream (server viejo): quien llama hace r.json() como siempre.
   Cada guardia de secuencia la pone quien recibe el evento; aborted corta el
   reader del fetch, asi que no hace falta un check intermedio. */
export async function consumeWaves(r, { onCatalog, onTracks } = {}) {
  if (!/ndjson/i.test(r.headers.get("content-type") || "") || !r.body?.getReader) return false;
  const reader = r.body.getReader();
  try {
    await leerNdjson(reader, (ev) => {
      if (ev.type === "catalog") onCatalog?.(uniqueResults(ev.results), ev);
      else if (ev.type === "tracks") onTracks?.(ev.tracks);
    });
  } finally {
    reader.releaseLock?.();
  }
  return true;
}

/* Cola de filas "lazy": a lo sumo `limit` pedidos en vuelo, sin repetir una
   misma fila. `abort` corta los que vuelan y descarta los que esperan; lo usa
   el cambio de busqueda y el desmontaje. */
export function createWaveQueue({ match, onMatched, limit = 3 }) {
  const espera = [], visto = new Set(), acs = [];
  let volando = 0, muerto = false;
  const bomba = () => {
    while (!muerto && volando < limit && espera.length) {
      const t = espera.shift(), k = rowKey(t);
      if (visto.has(k)) continue;
      visto.add(k);
      volando++;
      const ac = new AbortController();
      acs.push(ac);
      match(t, ac.signal)
        .then((full) => { if (!muerto) onMatched?.(full); })
        .catch(() => {})
        .finally(() => { volando--; bomba(); });
    }
  };
  return {
    add(t) {
      if (!muerto && t && !visto.has(rowKey(t))) { espera.push(t); bomba(); }
    },
    abort() { muerto = true; espera.length = 0; acs.forEach((c) => c.abort()); },
  };
}
