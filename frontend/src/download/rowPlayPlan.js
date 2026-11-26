import { needsResolve } from "./resolveResult.js";
import { matchState } from "./searchWaves.js";
import { canAudition, canStream } from "./streamTrack.js";

/* ---------------------------------------------------------------------------
   QUE SUENA AL TOCAR UNA FILA DE BUSCAR

   La decision, sola: la fila no sabe de React, el motor ni el DOM. El orden
   importa: primero lo que ya esta listo para sonar, luego lo que hay que
   resolver y al final el avance de 30 s. `null` = no hay nada que reproducir.
   Modulo puro: se prueba en Node.
   ------------------------------------------------------------------------- */

export function rowPlayPlan(t) {
  if (!t) return null;
  if (canStream(t)) return "stream";
  if (canAudition(t)) return "archive";
  /* Fila de una ola todavia sin video: el toque pide su match con prioridad
     y suena entera o, si no hay video, el avance de 30 s. */
  const state = matchState(t);
  if (state === "pending" || state === "lazy") return "eager";
  if (needsResolve(t)) return "resolve";
  if (t?.preview_url) return "preview";
  return null;
}

/* La pastilla de datos de la fila: «Buscando» solo mientras el servidor la
   busca de verdad (pending); una "lazy" espera a verse callada y pasa directo
   a entera o a «30 s». «YouTube ocupado» es un «30 s» con motivo: el circuito
   esta abierto (bot wall/429) y esta fila cayo al avance sin buscar nada, no
   porque no exista version entera. */
export function rowChip(t, plan = rowPlayPlan(t)) {
  if (plan === "eager") return matchState(t) === "pending" ? "seek" : null;
  if (plan !== "preview") return null;
  return t?.extra?.youtube_busy ? "busy" : "30";
}
