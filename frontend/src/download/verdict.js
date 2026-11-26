import { useSyncExternalStore } from "react";
import { fold } from "../listen/library.js";
import { API, errMsg, fetchErr, rowKey } from "../shared/api.js";
import { V_EXPLAIN } from "../shared/Verdict.jsx";
import { setBoundedMap } from "../shared/bounded.js";
import { trackState } from "./constants.js";

/* Una busqueda verificada por consulta: suficiente para una sesion larga sin
   crecer sin tope. */
const VERDICT_CAP = 200;

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

/* Una sola explicacion por veredicto, la misma que usa la pastilla
   (shared/Verdict.jsx): intentado-y-fallido y nunca-comprobado dicen lo mismo,
   «Sin verificar» no necesita distinguirlos. */
export function vText(key) {
  return V_EXPLAIN[key];
}

/* Un veredicto depende de la consulta: el mismo audio puede coincidir con una y
   no con otra. */
export const verdictKey = (t, query) => `${rowKey(t)}|${fold(query)}`;

/* Un video de YouTube se juzga por su TITULO contra la consulta, no por el audio. */
export const byVideo = (t) => t.source === "ytdlp" || !!t.extra?.webpage_url;

export function createVerdictStore(fetchImpl = (...a) => fetch(...a)) {
  const recs = new Map();
  const listeners = new Set();
  const flight = new Map();

  /* Antes copiaba el Map entero en cada put (O(n)): con muchas busquedas
     verificadas en una sesion larga cada escritura se iba haciendo mas lenta.
     Mutar en el sitio es seguro: nadie lee `recs` entero, solo `get(key)`. */
  const put = (key, rec) => {
    setBoundedMap(recs, key, rec, VERDICT_CAP);
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
            /* El archivo exacto que se bajaria: con el se puede escuchar antes. */
            audio: d.audio_url || null,
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
