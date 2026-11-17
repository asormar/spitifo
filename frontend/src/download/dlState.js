/* --- La descarga de una fila ---------------------------------------------------
   `job` es el del jobsStore (solo yt-dlp tiene); `busy` vale desde que se pulsa
   hasta que termina, tambien en las fuentes directas (sin job). Un job en error
   se ve como reposo: el aviso ya dice que fallo.

   Vive aparte de searchPlan.js: el shell (progress.jsx) lo necesita en el chunk
   de arranque y asi el resto de decisiones de Buscar se queda en el chunk
   perezoso de la pantalla. searchPlan.js lo reexporta para quien ya lo importa
   de ahi. */
export function dlState({ busy = false, job, downloaded = false }) {
  const s = job?.status;
  if (s === "error") return { id: "err", pct: 0 };
  /* "queued" es la cola del servidor (dos a la vez); "pending", esperar el
     candado de la misma pista. Para la fila son lo mismo: en cola. */
  if (s === "pending" || s === "queued") return { id: "queued", pct: 0 };
  /* `phase` afina el estado: "preparing" es la extraccion de yt-dlp (antes de
     que llegue un byte) y "saving" la escritura en la biblioteca. */
  if (s === "downloading") {
    if (job.phase === "preparing") return { id: "prep", pct: 0 };
    return { id: "down", pct: Math.min(100, Math.max(0, Math.round(job.progress || 0))) };
  }
  if (s === "processing") return { id: job.phase === "saving" ? "save" : "proc", pct: 100 };
  if (s === "done" || (!busy && downloaded)) return { id: "done", pct: 100 };
  return busy ? { id: "direct", pct: 0 } : { id: "idle", pct: 0 };
}

/* Hay una descarga en curso (el boton no se pulsa hasta que acabe). */
const WAITING = new Set(["queued", "prep", "down", "proc", "save", "direct"]);
export const dlWaiting = ({ id }) => WAITING.has(id);

/* El texto del boton de la ficha y, salvo en reposo y listo, el nombre accesible
   de la fila. */
export function dlText({ id, pct }) {
  return {
    idle: "Descargar",
    err: "Falló la descarga",
    queued: "En cola",
    prep: "Preparando…",
    down: `Descargando, ${pct} %`,
    proc: "Procesando el archivo…",
    save: "Guardando…",
    direct: "Descargando…",
    done: "Descargado",
  }[id];
}
