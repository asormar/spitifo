import { localSetting } from "../shared/localSetting.js";

/* ---------------------------------------------------------------------------
   PREFERENCIAS DEL ESCRITORIO

   El ancho del riel, el de la columna de "Ahora suena", el colapso del riel y
   la barra de titulo propia son preferencias de la persona, como el tema: se
   guardan en este dispositivo y se leen una vez al montar el shell. Las dos
   clamps son puras y se prueban en Node; el CSS solo lee las variables que
   `applyPrefs` escribe en <html>.
   ------------------------------------------------------------------------- */

export const RAIL_MIN = 200;
export const RAIL_MAX = 320;
export const RAIL_DEFAULT = 232;
export const RAIL_COLLAPSED = 64;
export const PANEL_MIN = 280;
export const PANEL_MAX = 520;
export const PANEL_DEFAULT = 340;

const num = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

export const clampRail = (value) => num(value, RAIL_DEFAULT, RAIL_MIN, RAIL_MAX);
export const clampPanel = (value) => num(value, PANEL_DEFAULT, PANEL_MIN, PANEL_MAX);

/* El ancho real del riel: la compacta es una preferencia, no un ancho a medias
   entre 64 y 200 (ahí las etiquetas no cabrían y los tooltips se solaparían). */
export const railWidth = (collapsed, width) => (collapsed ? RAIL_COLLAPSED : clampRail(width));

const readBool = (s) => s === "1" || s === "true";
const writeBool = (v) => (v ? "1" : "0");
const bool = (v) => v === true || v === "true" || v === "1";

export const collapsedSetting = localSetting("spitifo:rail-collapsed", false, {
  read: readBool,
  write: writeBool,
  normalize: bool,
});
export const railSetting = localSetting("spitifo:rail-width", RAIL_DEFAULT, {
  read: (s) => Number(s),
  write: String,
  valid: (v) => Number.isFinite(v),
  normalize: clampRail,
});
export const panelSetting = localSetting("spitifo:panel-width", PANEL_DEFAULT, {
  read: (s) => Number(s),
  write: String,
  valid: (v) => Number.isFinite(v),
  normalize: clampPanel,
});
export const titleBarSetting = localSetting("spitifo:custom-titlebar", false, {
  read: readBool,
  write: writeBool,
  normalize: bool,
});

/* Escribe las variables que consumen shell.css, base.css y nowplaying.css. */
export function applyPrefs() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--nav-w", `${railWidth(collapsedSetting.get(), railSetting.get())}px`);
  root.style.setProperty("--np-w", `${clampPanel(panelSetting.get())}px`);
  document.body.classList.toggle("rail-collapsed", collapsedSetting.get());
  document.body.classList.toggle("custom-titlebar", titleBarSetting.get());
}

/* Engancha las cuatro preferencias y devuelve el alto. En el navegador (sin
   Tauri) las llamadas a la ventana no hacen nada; la barra propia se oculta. */
export function watchPrefs() {
  applyPrefs();
  const offs = [
    collapsedSetting.subscribe(applyPrefs),
    railSetting.subscribe(applyPrefs),
    panelSetting.subscribe(applyPrefs),
    titleBarSetting.subscribe(applyPrefs),
  ];
  return () => offs.forEach((off) => off());
}
