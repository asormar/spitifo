import { FORMATS, MEDIA_OPTIONS } from "../download/constants.js";
import { localSetting } from "../shared/localSetting.js";

/* Preferencias de descarga, un valor por dispositivo en localStorage. El
   default NO recodifica: "original" conserva el contenedor de la fuente. mp3
   es una eleccion explicita y su coste se avisa en Ajustes. */
export const DOWNLOAD_FMT_KEY = "spitifo:download-format";
export const DOWNLOAD_MEDIA_KEY = "spitifo:download-media";
export const DOWNLOAD_WIFI_KEY = "spitifo:download-wifi-only";
export const DOWNLOAD_ROAMING_KEY = "spitifo:download-roaming-allowed";
export const DOWNLOAD_QUALITY_KEY = "spitifo:download-quality";

export const DEFAULT_FMT = "original";
export const DEFAULT_MEDIA = "audio";
export const DEFAULT_WIFI_ONLY = false;
export const DEFAULT_ROAMING_ALLOWED = true;
export const DEFAULT_QUALITY = "normal";

/* [id, etiqueta, formato, MB estimados por tema] */
const QUALITY = [
  ["ahorro", "Ahorro", "m4a", 3],
  ["normal", "Normal", "original", 4],
  ["alta", "Alta", "original", 7],
];
export const QUALITY_OPTIONS = QUALITY.map(([id, label]) => ({ id, label }));

const FMT_IDS = FORMATS.map((f) => f.value);
const MEDIA_IDS = MEDIA_OPTIONS.map((m) => m.id);
const QUALITY_IDS = QUALITY.map((q) => q[0]);

const _leer = (s, k) => { try { return s?.getItem(k); } catch { return null; } };
const _store = () => (typeof localStorage === "undefined" ? null : localStorage);

export function readDownloadFormat(storage = _store()) {
  const v = _leer(storage, DOWNLOAD_FMT_KEY);
  return FMT_IDS.includes(v) ? v : DEFAULT_FMT;
}
export function readDownloadMedia(storage = _store()) {
  const v = _leer(storage, DOWNLOAD_MEDIA_KEY);
  return MEDIA_IDS.includes(v) ? v : DEFAULT_MEDIA;
}
export function readDownloadWifiOnly(storage = _store()) {
  const v = _leer(storage, DOWNLOAD_WIFI_KEY);
  return v === null ? DEFAULT_WIFI_ONLY : v === "1";
}
export function readDownloadRoaming(storage = _store()) {
  const v = _leer(storage, DOWNLOAD_ROAMING_KEY);
  return v === null ? DEFAULT_ROAMING_ALLOWED : v === "1";
}
export function readDownloadQuality(storage = _store()) {
  const v = _leer(storage, DOWNLOAD_QUALITY_KEY);
  return QUALITY_IDS.includes(v) ? v : DEFAULT_QUALITY;
}

export function qualityHint(quality, { video = false } = {}) {
  const q = QUALITY.find((x) => x[0] === quality) || QUALITY[1];
  return video ? `${q[1]} · el vídeo ocupa bastante más` : `${q[1]} · unos ${q[3]} MB por canción`;
}

/* La calidad elegida manda sobre el picker para que el estimador no mienta. */
export function formatForQuality(quality) {
  return (QUALITY.find((x) => x[0] === quality) || QUALITY[1])[2];
}

export const downloadFormat = localSetting(DOWNLOAD_FMT_KEY, DEFAULT_FMT, {
  read: readDownloadFormat, write: (v) => v, valid: (v) => FMT_IDS.includes(v),
});
export const downloadMedia = localSetting(DOWNLOAD_MEDIA_KEY, DEFAULT_MEDIA, {
  read: readDownloadMedia, write: (v) => v, valid: (v) => MEDIA_IDS.includes(v),
});
export const downloadWifiOnly = localSetting(DOWNLOAD_WIFI_KEY, DEFAULT_WIFI_ONLY, {
  read: readDownloadWifiOnly, write: (v) => (v ? "1" : "0"),
  valid: (v) => typeof v === "boolean",
});
export const downloadRoaming = localSetting(DOWNLOAD_ROAMING_KEY, DEFAULT_ROAMING_ALLOWED, {
  read: readDownloadRoaming, write: (v) => (v ? "1" : "0"),
  valid: (v) => typeof v === "boolean",
});
export const downloadQuality = localSetting(DOWNLOAD_QUALITY_KEY, DEFAULT_QUALITY, {
  read: readDownloadQuality, write: (v) => v, valid: (v) => QUALITY_IDS.includes(v),
});

export const useDownloadFormat = downloadFormat.use;
export const useDownloadMedia = downloadMedia.use;
export const useDownloadWifiOnly = downloadWifiOnly.use;
export const useDownloadRoaming = downloadRoaming.use;
export const useDownloadQuality = downloadQuality.use;
