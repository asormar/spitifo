import { useSyncExternalStore } from "react";

/* ---------------------------------------------------------------------------
   ESCRITORIO O TELEFONO

   Un solo umbral para el shell: desde 960 px mandan el menu lateral, la barra
   de arriba y la barra del reproductor; por debajo, la barra inferior y la
   pastilla. El CSS no puede importar esta constante: el 960 de shell.css
   tiene que coincidir con PC_MIN.
   ------------------------------------------------------------------------- */

export const PC_MIN = 960;
const PC_QUERY = `(min-width: ${PC_MIN}px)`;

export const isPc = () => window.matchMedia(PC_QUERY).matches;

const watch = (cb) => {
  const mq = window.matchMedia(PC_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/* Ventana de escritorio. Un solo juego de chrome se monta a la vez. */
export const usePc = () => useSyncExternalStore(watch, isPc);
