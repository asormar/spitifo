import { useSyncExternalStore } from "react";

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

let enabled = readAutoDownload();
const listeners = new Set();

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const get = () => enabled;

function set(value) {
  enabled = Boolean(value);
  try {
    localStorage.setItem(AUTO_DOWNLOAD_KEY, enabled ? "1" : "0");
  } catch {
    /* Sin almacenamiento: se aplica igual mientras dure la sesion. */
  }
  listeners.forEach((fn) => fn());
}

export const autoDownload = { get, set, subscribe };

/* Devuelve [valor, cambiar], que es lo que desestructura Ajustes. */
export const useAutoDownload = () => [useSyncExternalStore(subscribe, get), set];
