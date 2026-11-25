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

  /* Actualiza UN job sin tocar los demas. Un error NO se retira solo: la fila
     se queda fallida (con su motivo y su reintento) hasta un reintento con
     exito o un descarte explicito; solo el toast de progreso lee el mismo job
     y ese sigue retirandose por su cuenta (Strip/ProgressBar no usan temporizador
     propio). */
  const setJobFor = (key, patch) => {
    jobs = { ...jobs, [key]: { ...jobs[key], ...patch, key } };
    if (!isTerminal(jobs[key]) || jobs[key].status === "error") {
      clearTimeout(timers.get(key));
      timers.delete(key);
    } else if (!timers.has(key)) {
      timers.set(key, setTimeout(() => drop(key), dismissMs));
    }
    emit();
  };

  /* Descarte explicito de una fila fallida: la saca del almacen sin esperar. */
  const dismiss = (key) => {
    if (jobs[key]?.status !== "error") return;
    clearTimeout(timers.get(key));
    timers.delete(key);
    drop(key);
  };

  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  return { subscribe, getJobs: () => jobs, setJobFor, dismiss };
}

export const jobsStore = createJobsStore();

/* El mapa clave -> job; cambia de identidad solo cuando cambia un job. */
export const useJobs = () => useSyncExternalStore(jobsStore.subscribe, jobsStore.getJobs);

/* Un solo job: setJobFor solo reemplaza el objeto del job tocado, asi que el
   sondeo de 700 ms vuelve a pintar UNA fila y no todas. */
export const useJob = (key) =>
  useSyncExternalStore(jobsStore.subscribe, () => jobsStore.getJobs()[key]);

/* Lo que publica el espejo de la cola en jobsStore. */
export const setJobFor = jobsStore.setJobFor;
/* Descarte explicito de una fila fallida (el motivo deja de verse). */
export const dismissJob = jobsStore.dismiss;
