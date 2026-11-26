import { localSetting } from "../shared/localSetting.js";

/* ---------------------------------------------------------------------------
   REPRODUCCIÓN Y DATOS

   Tres ajustes que viven en este dispositivo: la calidad de la transmisión, si
   se aplica «Ahorro de datos» cuando no hay Wi-Fi, y el crossfade que el motor
   de reproducción leerá en su fase. La calidad viaja al backend como query
   `quality` en `/api/stream`; `auto` no viaja (el backend ya hace eso por
   defecto, así que las URLs de siempre siguen siendo las de siempre).
   ------------------------------------------------------------------------- */

export const QUALITY_KEY = "spitifo:stream-quality";
export const AUTO_SAVER_KEY = "spitifo:stream-auto-saver";
/* Contrato con el motor de reproduccion (perf/playback): SEGUNDOS en esta
   clave, 0 = apagado. La UI trabaja con pasos (0 = apagado, n = n+1 s). */
export const CROSSFADE_KEY = "spitifo.playback.crossfade";

export const QUALITY_IDS = ["auto", "saver", "high"];
export const DEFAULT_QUALITY = "auto";
export const DEFAULT_AUTO_SAVER = true;
export const DEFAULT_CROSSFADE = 0;

/** MB estimados para una canción de 3:30, como dice la pantalla de Ajustes. */
export const QUALITY_OPTIONS = [
  { id: "auto", label: "Automática", sub: "Se ajusta a tu conexión · ~128 kbps", mb: "~3,5 MB" },
  { id: "saver", label: "Ahorro de datos", sub: "La más ligera · ~64 kbps", mb: "~1,7 MB" },
  { id: "high", label: "Alta", sub: "Mejor sonido · 320 kbps", mb: "~8,5 MB" },
];

/* El control va de 0 a 11: 0 es «Apagado» y el resto 2..12 s (anche 2 s). */
export const CROSSFADE_MAX = 11;
export const crossfadeLabel = (step) => (step === 0 ? "Apagado" : `${step + 1} s`);

function read(storage, key, valid, fallback) {
  try {
    const value = storage?.getItem(key);
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

const browserStorage = () => (typeof localStorage === "undefined" ? null : localStorage);
const isQuality = (v) => QUALITY_IDS.includes(v);
const isBool = (v) => v === true || v === false;
const isStep = (v) => Number.isInteger(v) && v >= 0 && v <= CROSSFADE_MAX;

export const readQuality = (storage = browserStorage()) => read(storage, QUALITY_KEY, isQuality, DEFAULT_QUALITY);
export const readAutoSaver = (storage = browserStorage()) => {
  try {
    const value = storage?.getItem(AUTO_SAVER_KEY);
    if (value === "true") return true;
    if (value === "false") return false;
  } catch {
    /* almacen bloqueado */
  }
  return DEFAULT_AUTO_SAVER;
};
export const secondsToStep = (s) => (Number.isInteger(s) && s >= 2 && s <= CROSSFADE_MAX + 1 ? s - 1 : 0);
export const stepToSeconds = (step) => (step === 0 ? 0 : step + 1);
export const readCrossfade = (storage = browserStorage()) => {
  const raw = read(storage, CROSSFADE_KEY, (v) => /^\d+$/.test(String(v)), "0");
  return secondsToStep(Number(raw));
};

export const quality = localSetting(QUALITY_KEY, DEFAULT_QUALITY, {
  read: readQuality,
  write: (v) => v,
  valid: isQuality,
});
export const autoSaver = localSetting(AUTO_SAVER_KEY, DEFAULT_AUTO_SAVER, {
  read: readAutoSaver,
  write: (v) => (v ? "true" : "false"),
  valid: isBool,
});
export const crossfade = localSetting(CROSSFADE_KEY, DEFAULT_CROSSFADE, {
  read: readCrossfade,
  write: (v) => String(stepToSeconds(v)),
  valid: isStep,
});

export const useQuality = quality.use;
export const useAutoSaver = autoSaver.use;
export const useCrossfade = crossfade.use;

/** El interruptor solo decide CUÁNDO se aplica el ahorro, no inventa un nivel. */
export function effectiveQuality({ quality: level = DEFAULT_QUALITY, autoSaver: automatic = false, mobile = false } = {}) {
  return automatic && mobile ? "saver" : level;
}

/** `navigator.connection.type` es la señal que da el navegador; si no está,
 *  no suponemos que estamos en datos (un PC no lo tiene). */
export function onMobileData(nav = typeof navigator === "undefined" ? null : navigator) {
  const type = nav?.connection?.type;
  if (typeof type !== "string") return false;
  return type !== "wifi" && type !== "ethernet" && type !== "none";
}

/** Nivel que debe pedir el proxy ahora mismo. */
export function streamQualityParam() {
  return effectiveQuality({ quality: quality.get(), autoSaver: autoSaver.get(), mobile: onMobileData() });
}

/** Añade la calidad a una URL de stream ya construida. `auto` no viaja. */
export function withStreamQuality(url, level = streamQualityParam()) {
  if (!url || level === DEFAULT_QUALITY) return url;
  return `${url}${url.includes("?") ? "&" : "?"}quality=${encodeURIComponent(level)}`;
}
