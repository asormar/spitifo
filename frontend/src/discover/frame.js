/* ---------------------------------------------------------------------------
   MARCO DE "PARA TI": medidas

   Sin React ni DOM. Lo que el mapa necesita saber del panel antes de que el
   panel exista (el panel es un chunk aparte y llega despues del primer cuadro
   del mapa): cuanto tapa y si empieza recogido. El mapa encuadra con esto desde
   el primer cuadro y no se mueve cuando el panel de verdad aparece.
   ------------------------------------------------------------------------- */

/* Alto de la barra cuando la hoja esta recogida (telefono). */
export const PEEK = 56;
export const PANEL_W = 360;
/* Ancho que el panel quita al mapa: su ancho mas el margen a cada lado. */
export const PANEL_ROOM = PANEL_W + 12;
/* Bajo este ancho de mapa el panel empieza recogido: casi no dejaria mapa. */
export const PANEL_MIN_MAP = 820;

/* Panel lateral recogido al nacer: solo en ancho (no telefono) y mapa estrecho. */
export const startsCollapsed = (w, narrow) => !narrow && w < PANEL_MIN_MAP;

/* Lo que el panel tapa nada mas nacer, en el formato de setObstacle del mapa. */
export function startingObstacle({ w, narrow }) {
  if (narrow) return { bottom: PEEK + 8 };
  return { right: startsCollapsed(w, false) ? 0 : PANEL_ROOM };
}
