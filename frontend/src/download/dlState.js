/* --- La descarga de una fila ---------------------------------------------------
   `job` es el del jobsStore (solo yt-dlp tiene); `busy` vale desde que se pulsa
   hasta que termina, tambien en las fuentes directas (sin job). Un job en error
   se ve como reposo: el aviso ya dice que fallo.

   Vive aparte de searchPlan.js: el shell (progress.jsx) lo necesita en el chunk
   de arranque y asi el resto de decisiones de Buscar se queda en el chunk
   perezoso de la pantalla.
   */
/* El transporte nunca llega al usuario: un motivo corto por error_code, nunca
   el mensaje crudo de yt-dlp. */
const FAIL_REASON = {
  transient: "problema de red",
  permanent: "archivo no disponible",
  youtube_bot_check: "verificación de YouTube",
};

export function dlState({ busy = false, job, downloaded = false }) {
  const s = job?.status;
  if (s === "error") return { id: "err", pct: 0, reason: FAIL_REASON[job?.error_code] || "no se pudo completar" };
  /* "queued" es la cola del servidor (4 en red / 2 transcodificando);
     "pending" espera el candado de la misma pista. Las fases waiting_* son la
     compuerta de red (R2): el item sigue en cola pero dice POR QUE espera. */
  if (s === "pending" || s === "queued") {
    if (job?.phase === "waiting_wifi") return { id: "waitwifi", pct: 0 };
    if (job?.phase === "waiting_roaming") return { id: "waitroam", pct: 0 };
    if (job?.phase === "waiting_network") return { id: "waitnet", pct: 0 };
    return { id: "queued", pct: 0 };
  }
  /* `phase` afina el estado: "preparing" es la extraccion de yt-dlp (antes de
     que llegue un byte), "uploading" la subida real a la nube y "saving" el
     cierre del registro. */
  if (s === "downloading") {
    if (job.phase === "preparing") return { id: "prep", pct: 0 };
    return { id: "down", pct: Math.min(100, Math.max(0, Math.round(job.progress || 0))) };
  }
  if (s === "processing") {
    /* La subida tiene su PROPIO porcentaje: antes el anillo se congelaba en
       100 % durante el PUT mas largo (P-downloads-pipeline-3). */
    if (job.phase === "uploading")
      return { id: "upload", pct: Math.min(100, Math.max(0, Math.round(job.progress || 0))) };
    return { id: job.phase === "saving" ? "save" : "proc", pct: 100 };
  }
  if (s === "done" || (!busy && downloaded)) return { id: "done", pct: 100 };
  return busy ? { id: "direct", pct: 0 } : { id: "idle", pct: 0 };
}

/* Hay una descarga en curso (el boton no se pulsa hasta que acabe). */
const WAITING = new Set(["queued", "prep", "down", "proc", "upload", "save",
  "direct", "waitwifi", "waitroam", "waitnet"]);
export const dlWaiting = ({ id }) => WAITING.has(id);

/* El texto del boton de la ficha y, salvo en reposo y listo, el nombre accesible
   de la fila. */
export function dlText({ id, pct, reason }) {
  if (id === "err") return `Falló: ${reason || "no se pudo completar"}`;
  return {
    idle: "Descargar",
    queued: "En cola",
    waitwifi: "Esperando Wi-Fi",
    waitroam: "Esperando sin roaming",
    waitnet: "Esperando red",
    prep: "Preparando…",
    down: `Descargando, ${pct} %`,
    upload: `Subiendo, ${pct} %`,
    proc: "Procesando el archivo…",
    save: "Guardando…",
    direct: "Descargando…",
    done: "Descargado",
  }[id];
}
