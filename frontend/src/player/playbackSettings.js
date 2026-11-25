import { localSetting } from "../shared/localSetting.js";

/* ---------------------------------------------------------------------------
   AJUSTE DE REPRODUCCION: CROSSFADE

   Envoltorio del ajuste local de siempre: Ajustes usa get/set y el motor lee
   el valor al cambiar de pista. Segundos, 0 = desactivado (default), 2-12 s.
   ------------------------------------------------------------------------- */

export const CROSSFADE_KEY = "spitifo.playback.crossfade";
export const CROSSFADE_MIN_S = 2;
export const CROSSFADE_MAX_S = 12;

export function normalizeCrossfade(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(CROSSFADE_MAX_S, Math.max(CROSSFADE_MIN_S, Math.round(n)));
}

const setting = localSetting(CROSSFADE_KEY, 0, {
  read: () => localStorage.getItem(CROSSFADE_KEY),
  write: (v) => String(v),
  normalize: normalizeCrossfade,
});

export const getCrossfade = setting.get;
export const setCrossfade = (seconds) => {
  setting.set(seconds);
  return normalizeCrossfade(seconds);
};
export const subscribeCrossfade = (fn) => setting.subscribe(() => fn(getCrossfade()));

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Con movimiento reducido no hay transicion, solo el cambio limpio. */
export const effectiveCrossfade = (value = getCrossfade(), reduce = prefersReducedMotion()) =>
  reduce ? 0 : normalizeCrossfade(value);
