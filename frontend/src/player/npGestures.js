/* ---------------------------------------------------------------------------
   GESTOS DE "AHORA SUENA"

   La aritmetica de los dos gestos del telefono (arrastrar para cerrar,
   deslizar la portada para saltar), separada de NowPlaying.jsx para poder
   probarla sin montar el componente: funciones puras, sin DOM. Las cifras son
   las de DESIGN.md (35 % de la distancia o 0,5 px/ms confirma; la resistencia
   es un tercio del recorrido extra pasado ese 35 %).
   ------------------------------------------------------------------------- */

/* Cierre por arrastre: 35 % de la altura, o rapido hacia abajo (px/ms). */
export const CLOSE_FRACTION = 0.35;
export const CLOSE_SPEED = 0.5;
/* Pasado el 35 %, la tarjeta solo avanza un tercio de lo que se tira de mas. */
export const RESIST = 1 / 3;
/* El scrim se desvanece hasta el 70 % de la altura (mas alla, ya esta a 0). */
export const SCRIM_RANGE = 0.7;

/* Deslizar la portada salta de cancion: mismas cifras que el cierre, pero en
   horizontal y sobre el ancho de la portada. */
export const SWIPE_FRACTION = 0.35;
export const SWIPE_SPEED = 0.5;

/* El `dy` que de verdad se pinta: pasado el umbral, resiste. */
export function resistedDy(rawDy, height) {
  const threshold = height * CLOSE_FRACTION;
  return rawDy > threshold ? threshold + (rawDy - threshold) * RESIST : rawDy;
}

/* Opacidad del scrim para un `dy` ya resistido: 1 en reposo, 0 a partir de
   SCRIM_RANGE de la altura. */
export function scrimOpacity(dy, height) {
  const p = Math.min(1, Math.max(0, dy) / (height * SCRIM_RANGE));
  return 1 - p;
}

/* ¿Se suelta la tarjeta (cierra) o vuelve a su sitio? `dy` ya resistido. */
export function shouldDismiss(dy, velocity, height) {
  return dy > height * CLOSE_FRACTION * 0.95 || velocity > CLOSE_SPEED;
}

/* ¿Se confirma el salto de cancion? */
export function shouldSkip(dx, velocity, width) {
  return Math.abs(dx) >= width * SWIPE_FRACTION || velocity > SWIPE_SPEED;
}
