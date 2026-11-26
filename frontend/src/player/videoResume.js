import { clock } from "../shared/format.js";

/* ---------------------------------------------------------------------------
   VUELTA A LA CANCION TRAS UN VIDEO

   El aviso que se muestra al cerrar un video que puso en pausa la cancion:
   separado de VideoHost.jsx para poder probar su texto sin montar el
   componente ni el <video>.
   ------------------------------------------------------------------------- */

export function resumeNotice(title, seconds) {
  return `Volviendo a «${title || "el audio"}» desde ${clock(seconds)}`;
}
