/* ---------------------------------------------------------------------------
   ARITMETICA DE GESTOS COMPARTIDA

   Las hojas y el swipe de modos usan LAS MISMAS cifras que el reproductor
   (fase 13): 35 % de la distancia o 0,5 px/ms confirman y, pasado el umbral,
   solo cuenta un tercio de lo que se tira de mas. Se reexportan las funciones
   puras de player/npGestures.js en vez de copiarlas: una sola fuente de verdad
   para los tres gestos.
   ------------------------------------------------------------------------- */

export {
  CLOSE_FRACTION,
  CLOSE_SPEED,
  RESIST,
  SCRIM_RANGE,
  SWIPE_FRACTION,
  SWIPE_SPEED,
  resistedDy,
  scrimOpacity,
  shouldDismiss,
  shouldSkip,
} from "../player/npGestures.js";

/* Movimiento minimo antes de decidir la direccion de un gesto. */
export const SLOP = 8;

/* Muestras recientes [valor, timeStamp]. Se guardan las cinco ultimas: con una
   muestra mas antigua la velocidad media se queda corta en un golpe rapido. */
export function pushSample(samples, value, time) {
  samples.push([value, time]);
  if (samples.length > 5) samples.shift();
  return samples;
}

/* px/ms entre la primera y la ultima muestra (0 si no hay tiempo). */
export function velocity(samples) {
  if (samples.length < 2) return 0;
  const [first, t0] = samples[0];
  const [last, t1] = samples[samples.length - 1];
  return t1 > t0 ? (last - first) / (t1 - t0) : 0;
}
