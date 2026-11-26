import { matchState } from "./searchWaves.js";

/* ---------------------------------------------------------------------------
   AVANCE AGREGADO (puro, sin React ni DOM)

   Antes cada fila sin terminar mostraba un punto quieto y la cabecera callaba
   el recuento hasta el final. Aqui se cuenta cuantas filas ya resolvieron su
   version (entera o sin ella) para decir «Buscando… N/Total» en vivo.
   ------------------------------------------------------------------------- */

const settled = (t) => {
  const s = matchState(t);
  return s === "full" || s === "none";
};

export function progressOf(results = [], total = results.length) {
  const resolved = results.filter(settled).length;
  const totalN = Math.max(0, Number(total) || 0);
  return {
    resolved,
    total: totalN,
    pending: Math.max(0, totalN - resolved),
    text: `Buscando versiones completas… ${resolved}/${totalN}`,
  };
}

/* Solo se muestra mientras queda algo por resolver o la respuesta no termino. */
export function needsProgress(results = [], streamDone = true) {
  return !streamDone || progressOf(results).pending > 0;
}
