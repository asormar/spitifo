import { clamp } from "../shared/ui.jsx";

/* ---------------------------------------------------------------------------
   ARITMETICA DE LA BARRA DE PROGRESO

   Separada de Scrub.jsx para poder probarla sin montar el componente ni
   simular un `pointermove`: funciones puras, sin DOM.
   ------------------------------------------------------------------------- */

/* Porcentaje (0-1) del punto `clientX` sobre un rail que empieza en `left` y
   mide `width`. Un rail sin medir (0 de ancho, aun sin layout) no divide por
   cero: se queda en el extremo izquierdo. */
export function pctFromPointer(clientX, left, width) {
  return width > 0 ? clamp((clientX - left) / width, 0, 1) : 0;
}

/* Desplazamiento en px del centro del tirador sobre el rail, para un `pct` y
   un ancho de rail dados. */
export function knobOffset(pct, railWidth, knobSize = 14) {
  return pct * railWidth - knobSize / 2;
}

/* Minuto entero de un instante: el detente haptic solo suena al cruzarlo, no
   en cada pointermove (§4). */
export const minuteOf = (seconds) => Math.floor(Math.max(0, seconds) / 60);
