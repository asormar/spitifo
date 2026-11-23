import { localSetting } from "../shared/localSetting.js";

/* ---------------------------------------------------------------------------
   DESCARGA AUTOMATICA DE LO GUARDADO

   Un ajuste simple del dispositivo, como el tema: un valor en localStorage que
   leen y escriben Ajustes y todas las formas de guardar. Sin servidor y sin
   prompt: apagado por defecto. Modulo con React solo para el hook; la lectura
   es pura y se prueba en Node con un almacen falso.
   ------------------------------------------------------------------------- */

export const AUTO_DOWNLOAD_KEY = "spitifo:auto-download";

export function readAutoDownload(storage = typeof localStorage === "undefined" ? null : localStorage) {
  try {
    return storage?.getItem(AUTO_DOWNLOAD_KEY) === "1";
  } catch {
    /* Modo privado o almacen bloqueado: el ajuste vale para esta visita. */
    return false;
  }
}

/* Boolean normaliza cualquier valor que llegue del conmutador; "1"/"0" es el
   formato guardado que entiende readAutoDownload. */
export const autoDownload = localSetting(AUTO_DOWNLOAD_KEY, false, {
  read: readAutoDownload,
  write: (on) => (on ? "1" : "0"),
  normalize: Boolean,
});

export const useAutoDownload = autoDownload.use;
