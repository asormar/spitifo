import { useSyncExternalStore } from "react";
import { fold } from "../listen/library.js";
import { API, errMsg, fetchErr, rowKey } from "../shared/api.js";
import { trackState } from "./constants.js";

/* ---------------------------------------------------------------------------
   VEREDICTOS

   Que dice la pastilla de un resultado, sin inventar nada. Antes de bajarlo, un
   resultado solo sabe si tiene el archivo entero («Sin verificar») o solo 30 s
   («Solo 30 s»): nadie ha mirado el audio. «Coincide», «Parecido» y «No
   coincide» salen unicamente de una verificacion («¿Es esta la cancion?») o de
   una descarga, y se guardan por resultado Y por consulta (el veredicto compara
   contra lo que se busco).

   El almacen vive en el modulo, como jobsStore: la fila, la ficha y el aviso
   leen lo mismo, y una fila repinta sola cuando cambia SU clave. No toca window
   ni document: se importa en Node para los tests.
   ------------------------------------------------------------------------- */

const V_TEXT = {
  match: "El audio es la canción que buscaste.",
  partial: "Se parece, pero no es exactamente lo que buscaste.",
  mismatch: "No es lo que buscabas.",
  p30: "Solo hay 30 s de esta fuente.",
  unv: "No se pudo identificar el audio.",
};

/* El backend dice match | partial | mismatch | unknown. */
const FROM_MATCH = { match: "match", partial: "partial", mismatch: "mismatch" };
const known = (rec) => rec?.phase === "done" && !!FROM_MATCH[rec.match];

/* La pastilla de un resultado: null = sin pastilla (ni descarga ni preview).
   `rec` es el registro de verificacion/descarga, si lo hay. */
export function verdictOf(t, rec) {
  const st = trackState(t);
  if (st === "preview") return "p30";
  if (st === "none") return null;
  return (rec?.phase === "done" && FROM_MATCH[rec.match]) || "unv";
}

/* `untested`: nunca se comprobo (distinto de «no se pudo identificar»). */
export function vText(key, { untested = false } = {}) {
  return key === "unv" && untested ? "Todavía no se ha comprobado el audio." : V_TEXT[key];
}

/* Un veredicto depende de la consulta: el mismo audio puede coincidir con una y
   no con otra. */
export const verdictKey = (t, query) => `${rowKey(t)}|${fold(query)}`;

/* Un video de YouTube se juzga por su TITULO contra la consulta, no por el audio. */
export const byVideo = (t) => t.source === "ytdlp" || !!t.extra?.webpage_url;

export function createVerdictStore(fetchImpl = (...a) => fetch(...a)) {
  let recs = new Map();
  const listeners = new Set();
  const flight = new Map();

  const put = (key, rec) => {
    recs = new Map(recs).set(key, rec);
    listeners.forEach((fn) => fn());
  };

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get: (key) => recs.get(key),

    /* La descarga termino: el backend ya comparo con el titulo (o las
       etiquetas). Una verificacion que SI identifico el audio no se pisa. El
       archivo nuevo de la biblioteca trae su propio veredicto guardado. */
    setFromDownload(t, query, d) {
      const key = verdictKey(t, query);
      const rec = {
        phase: "done",
        from: "download",
        match: d.match,
        real: d.real_title || null,
        by: byVideo(t) ? "video" : "file",
      };
      if (!known(recs.get(key))) put(key, rec);
    },

    /* Lee las etiquetas del audio sin bajarlo. Una sola peticion por clave. */
    verify(t, query) {
      const key = verdictKey(t, query);
      if (flight.has(key)) return flight.get(key);
      put(key, { phase: "loading" });
      const url =
        `${API}/verify?q=${encodeURIComponent(query)}&source=${t.source}` +
        `&source_id=${encodeURIComponent(t.source_id)}`;
      const job = (async () => {
        try {
          const r = await fetchImpl(url);
          const d = await r.json();
          if (!r.ok) throw new Error(errMsg(d, "no se pudo verificar"));
          const x = d.extra || {};
          put(key, {
            phase: "done",
            from: "verify",
            match: x.match,
            real: x.real_title || null,
            score: x.match_score ?? null,
            by: "file",
            extra: x,
          });
        } catch (e) {
          put(key, { phase: "error", error: fetchErr(e, e.message) });
        } finally {
          flight.delete(key);
        }
      })();
      flight.set(key, job);
      return job;
    },
  };
}

export const verdictStore = createVerdictStore();

export const useVerdict = (key) =>
  useSyncExternalStore(verdictStore.subscribe, () => verdictStore.get(key));
