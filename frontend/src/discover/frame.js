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

/* Los mismos ratios de sheetGeometry (gestures.js), sin importarlos: este
   modulo lo lee el mapa antes de que llegue el chunk de los gestos. */
const HALF_RATIO = 0.45;
const FULL_RATIO = 0.85;
const heightOf = (snap, h) => {
  const map = h || 600;
  const full = Math.max(PEEK + 120, Math.round(map * FULL_RATIO));
  if (snap === "full") return full;
  if (snap === "half") return Math.min(full - 40, Math.max(PEEK + 80, Math.round(map * HALF_RATIO)));
  return PEEK;
};

/* Primera visita de la sesión: la hoja nace a medias, no en una barra ciega.
   Despues se recuerda la ultima parada que eligio la persona. */
let lastSnap = null;
export const initialSnap = () => lastSnap || "half";
export const rememberSnap = (name) => {
  lastSnap = name;
};

/* Panel lateral recogido al nacer: solo en ancho (no telefono) y mapa estrecho. */
export const startsCollapsed = (w, narrow) => !narrow && w < PANEL_MIN_MAP;

/* Lo que el panel tapa nada mas nacer, en el formato de setObstacle del mapa. */
export function startingObstacle({ w, h, narrow }) {
  if (narrow) return { bottom: heightOf(initialSnap(), h) + 8 };
  return { right: startsCollapsed(w, false) ? 0 : PANEL_ROOM };
}
