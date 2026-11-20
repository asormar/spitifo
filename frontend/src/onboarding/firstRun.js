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

/* Las carpetas del sistema con su nombre de pantalla: es lo que se ve en el
   gestor de archivos del telefono o en el Explorador de Windows. */
const SYSTEM_NAMES = { Music: "Música", Download: "Descargas", Downloads: "Descargas", Documents: "Documentos" };

/* La ruta de la biblioteca como la reconoce cualquiera: «la carpeta Música ›
   Spitifo» en vez de /storage/emulated/0/Music/Spitifo. Se quita la parte que
   es del sistema (el almacenamiento del telefono o la carpeta del usuario) y
   quedan como mucho las tres ultimas carpetas. La ruta entera vive en Ajustes. */
export function folderLabel(path) {
  if (typeof path !== "string" || !path.trim()) return FALLBACK_FOLDER;
  const full = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const rest = full
    .replace(/^\/storage\/emulated\/\d+\//, "")
    .replace(/^[A-Za-z]:\/Users\/[^/]+\//i, "")
    .replace(/^\/(?:home|Users)\/[^/]+\//, "");
  const parts = rest.split("/").filter(Boolean).slice(rest === full ? -2 : -3);
  if (!parts.length) return FALLBACK_FOLDER;
  return `la carpeta ${parts.map((p) => SYSTEM_NAMES[p] || p).join(" › ")}`;
}

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
