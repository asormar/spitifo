import { needsResolve } from "./resolveResult.js";
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
  if (needsResolve(t)) return "resolve";
  if (t?.preview_url) return "preview";
  return null;
}
