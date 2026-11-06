import { useSyncExternalStore } from "react";
import { isTerminal } from "./api.js";
import { JOB_DISMISS_MS } from "./constants.js";

/* ---------------------------------------------------------------------------
   DESCARGAS EN CURSO

   Un almacen externo (como engine.js y playlists.js): clave -> job. Vive fuera
   de Buscar porque el sondeo sigue aunque la pantalla este oculta y el aviso
   de progreso (ProgressStack, o la lista del menu lateral en PC) lo pinta el
   shell, no la pantalla.

   Un job terminal (done/error/timeout/gone) se retira solo a los `dismissMs`.
   Cada job tiene SU temporizador, creado una sola vez cuando pasa a terminal:
   el de la primera descarga no puede borrar el aviso de la segunda. Si la
   misma cancion se vuelve a bajar antes de que venza, el job ya no es
   terminal: se cancela el temporizador y el nuevo final cuenta sus propios
   segundos.

   No toca window ni document: se importa en Node para los tests.
   ------------------------------------------------------------------------- */

export function createJobsStore(dismissMs = JOB_DISMISS_MS) {
  let jobs = {};
  const listeners = new Set();
  const timers = new Map();

  const emit = () => listeners.forEach((fn) => fn());

  const drop = (key) => {
    timers.delete(key);
    if (!isTerminal(jobs[key])) return;
    const next = { ...jobs };
    delete next[key];
    jobs = next;
    emit();
  };

  /* Actualiza UN job sin tocar los demas. */
  const setJobFor = (key, patch) => {
    jobs = { ...jobs, [key]: { ...jobs[key], ...patch, key } };
    if (!isTerminal(jobs[key])) {
      clearTimeout(timers.get(key));
      timers.delete(key);
    } else if (!timers.has(key)) {
      timers.set(key, setTimeout(() => drop(key), dismissMs));
    }
    emit();
  };

  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  return { subscribe, getJobs: () => jobs, setJobFor };
}

export const jobsStore = createJobsStore();

/* El mapa clave -> job; cambia de identidad solo cuando cambia un job. */
export const useJobs = () => useSyncExternalStore(jobsStore.subscribe, jobsStore.getJobs);

/* Lo que reciben pollJob y onDownload. */
export const setJobFor = jobsStore.setJobFor;
