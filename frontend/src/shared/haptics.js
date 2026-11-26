import { localSetting } from "./localSetting.js";

/* ---------------------------------------------------------------------------
   HAPTICA (U-mobile-native-feel-6)

   Puente a `SpitifoAndroid.haptic(kind)`. Solo confirmaciones discretas: el
   corazon, una hoja o una fila reordenada que encaja, una descarga terminada y
   el detente del scrubber en un minuto exacto. Nunca en cada toque ni en un
   gesto continuo. Un interruptor en Ajustes la apaga entera.
   ------------------------------------------------------------------------- */

export const HAPTIC = Object.freeze({ CONFIRM: 0, DETENT: 1 });

const KEY = "spitifo:haptics";

export const haptics = localSetting(KEY, true, {
  read: () => {
    try {
      return globalThis.localStorage?.getItem(KEY);
    } catch {
      return null;
    }
  },
  write: (on) => (on ? "on" : "off"),
  valid: (on) => typeof on === "boolean",
  /* Lo que haya escrito un cliente viejo (o nada) se lee como encendido. */
  normalize: (value) => value !== "off" && value !== false,
});

export const useHaptics = haptics.use;

/* Un WebView que no es Android, o una version anterior del bridge, simplemente
   no vibra; la interfaz no depende de que el puente exista. */
export function haptic(kind = HAPTIC.CONFIRM) {
  if (!haptics.get()) return;
  try {
    globalThis.SpitifoAndroid?.haptic?.(kind);
  } catch {
    /* Bridge roto: la confirmacion visual ya ocurrio, no hay que hacer nada. */
  }
}
