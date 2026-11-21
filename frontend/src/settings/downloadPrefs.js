import { FORMATS, MEDIA_OPTIONS } from "../download/constants.js";
import { localSetting } from "../shared/localSetting.js";

/* ---------------------------------------------------------------------------
   PREFERENCIAS DE DESCARGA

   El formato y el contenido vivian en la cabecera de Buscar como estado local.
   Ahora se eligen en Ajustes, pero la descarga los lee igual: un valor por
   dispositivo en localStorage, con los mismos defaults de siempre (m4a / solo
   audio). Modulo con React solo para los hooks; la lectura es pura y se prueba
   en Node con un almacen falso.
   ------------------------------------------------------------------------- */

export const DOWNLOAD_FMT_KEY = "spitifo:download-format";
export const DOWNLOAD_MEDIA_KEY = "spitifo:download-media";

export const DEFAULT_FMT = "m4a";
export const DEFAULT_MEDIA = "audio";

const FMT_IDS = FORMATS.map((f) => f.value);
const MEDIA_IDS = MEDIA_OPTIONS.map((m) => m.id);

export function readDownloadFormat(storage = typeof localStorage === "undefined" ? null : localStorage) {
  try {
    const value = storage?.getItem(DOWNLOAD_FMT_KEY);
    return FMT_IDS.includes(value) ? value : DEFAULT_FMT;
  } catch {
    /* Modo privado o almacen bloqueado: el default vale para esta visita. */
    return DEFAULT_FMT;
  }
}

export function readDownloadMedia(storage = typeof localStorage === "undefined" ? null : localStorage) {
  try {
    const value = storage?.getItem(DOWNLOAD_MEDIA_KEY);
    return MEDIA_IDS.includes(value) ? value : DEFAULT_MEDIA;
  } catch {
    return DEFAULT_MEDIA;
  }
}

export const downloadFormat = localSetting(DOWNLOAD_FMT_KEY, DEFAULT_FMT, {
  read: readDownloadFormat,
  write: (fmt) => fmt,
  valid: (fmt) => FMT_IDS.includes(fmt),
});

export const downloadMedia = localSetting(DOWNLOAD_MEDIA_KEY, DEFAULT_MEDIA, {
  read: readDownloadMedia,
  write: (media) => media,
  valid: (media) => MEDIA_IDS.includes(media),
});

/* Pares valor/cambiar, como useTheme y useAutoDownload. */
export const useDownloadFormat = downloadFormat.use;
export const useDownloadMedia = downloadMedia.use;
