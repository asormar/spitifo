import Ico from "../shared/ico.jsx";
import { JOB_DISMISS_MS } from "./constants.js";
import { useJobs } from "./jobsStore.js";

/* Un toast por descarga en curso. Con dos a la vez se apilan en columna: el
   primero se apila pegado al borde inferior. Cada uno se retira solo a los 5 s
   de terminar, con su propio temporizador (jobsStore). Lo monta el shell: la
   pantalla de Buscar puede estar oculta mientras la descarga sigue. `inline`:
   en escritorio las mismas tarjetas van dentro del menu lateral, sin flotar. */
export function ProgressStack({ inline = false }) {
  const lista = Object.values(useJobs());
  const varios = lista.length > 1;
  /* Siempre montado: una region viva que aparece junto con su contenido no se
     anuncia de forma fiable. Vacia no pinta nada. */
  return (
    <div className={inline ? "jobs" : `progstack ${varios ? "is-multi" : ""}`} aria-live="polite">
      {lista.map((j, i) => (
        <ProgressBar key={j.key || j.title + i} job={j} />
      ))}
    </div>
  );
}

export function ProgressBar({ job }) {
  if (!job) return null;
  const pct = Math.round(job.progress || 0);
  const done = job.status === "done";
  const failed = job.status === "error";
  /* El tope de espera se vencio o el job ya no existe: no fallo, pero tampoco
     se puede seguir mirando. No es "descargando" porque ya no lo sabemos. */
  const halted = job.status === "timeout" || job.status === "gone";
  const shown = done ? 100 : Math.max(pct, 2);
  return (
    <div
      className={`prog ${done ? "is-done" : ""} ${failed || halted ? "is-failed" : ""}`}
      style={{ "--dismiss": `${JOB_DISMISS_MS}ms` }}
    >
      <div className="prog__top">
        <span className="prog__ico">
          {failed || halted ? (
            <Ico n="warn" size={19} />
          ) : done ? (
            <Ico n="check" size={19} />
          ) : (
            <span className="sp" aria-hidden="true" />
          )}
        </span>
        <span className="prog__title">{job.title}</span>
        {/* El porcentaje cambia cada ~700 ms: solo se anuncian los estados finales. */}
        <span className="prog__state" aria-hidden={done || failed || halted ? undefined : true}>
          {failed
            ? "Falló la descarga"
            : done
            ? "Listo, está en tu biblioteca"
            : halted
            ? job.status === "gone"
              ? "El servidor ya no tiene esta descarga"
              : "Sigue descargando en el servidor"
            : job.status === "pending"
            ? "En cola"
            : job.status === "processing"
            ? "Procesando el archivo…"
            : `Descargando, ${pct} %`}
        </span>
      </div>
      <div
        className="prog__bar"
        role="progressbar"
        aria-label="Progreso de la descarga"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={done ? 100 : pct}
      >
        <div className="prog__fill" style={{ transform: `scaleX(${shown / 100})` }} />
      </div>
    </div>
  );
}
