import { CROSSFADE_KEY, crossfade, secondsToStep, stepToSeconds } from "../settings/playbackSettings.js";

/* ---------------------------------------------------------------------------
   AJUSTE DE REPRODUCCION: CROSSFADE

   La vista del motor sobre el MISMO ajuste que pinta Ajustes
   (settings/playbackSettings.js): una sola instancia, asi un cambio en Ajustes
   llega al motor sin recargar. Aqui se habla en segundos, 0 = desactivado
   (default), 2-12 s; Ajustes guarda pasos del control.
   ------------------------------------------------------------------------- */

export { CROSSFADE_KEY };
export const CROSSFADE_MIN_S = 2;
export const CROSSFADE_MAX_S = 12;

export function normalizeCrossfade(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(CROSSFADE_MAX_S, Math.max(CROSSFADE_MIN_S, Math.round(n)));
}

export const getCrossfade = () => stepToSeconds(crossfade.get());
export const setCrossfade = (seconds) => {
  const next = normalizeCrossfade(seconds);
  crossfade.set(secondsToStep(next));
  return next;
};
export const subscribeCrossfade = (fn) => crossfade.subscribe(() => fn(getCrossfade()));

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Con movimiento reducido no hay transicion, solo el cambio limpio. */
export const effectiveCrossfade = (value = getCrossfade(), reduce = prefersReducedMotion()) =>
  reduce ? 0 : normalizeCrossfade(value);
