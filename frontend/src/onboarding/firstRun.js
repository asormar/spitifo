import { useSyncExternalStore } from "react";

/* ---------------------------------------------------------------------------
   PRIMERA EJECUCION

   La tarjeta de Inicio se muestra solo mientras la biblioteca esta vacia y el
   usuario no la ha descartado. El estado se guarda en este dispositivo:
     ausente     -> mostrar mientras la biblioteca este vacia
     "dismissed" -> no mostrar nunca mas (Entendido)
     "show"      -> mostrar aunque la biblioteca tenga canciones (Ajustes)
   La decision pura vive en `shouldShowFirstRun`, sin React ni localStorage.
   ------------------------------------------------------------------------- */

export const FLAG_KEY = "spitifo-first-run";
export const FALLBACK_FOLDER = "la carpeta que ves en Ajustes";

let flag = null;
try {
  flag = localStorage.getItem(FLAG_KEY);
} catch {
  /* modo privado o almacenamiento bloqueado: no se recuerda entre visitas */
}

const listeners = new Set();
const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const snapshot = () => flag;

const set = (value) => {
  flag = value;
  try {
    if (value) localStorage.setItem(FLAG_KEY, value);
    else localStorage.removeItem(FLAG_KEY);
  } catch {
    /* igual que arriba: el cambio vale para esta visita */
  }
  listeners.forEach((fn) => fn());
};

export const dismissFirstRun = () => set("dismissed");
export const requestFirstRun = () => set("show");

/* Logica pura: `count` es el numero de archivos de la biblioteca y `value` el
   valor guardado (o null si nunca se decidio). */
export function shouldShowFirstRun(count, value) {
  if (value === "show") return true;
  if (value === "dismissed") return false;
  return count === 0;
}

export const useFirstRunFlag = () => useSyncExternalStore(subscribe, snapshot);
