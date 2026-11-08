import { JOB_DISMISS_MS } from "./constants.js";
import Ico from "../shared/ico.jsx";

/* ---------------------------------------------------------------------------
   AVISO DE LA PANTALLA (strip)

   ok: una descarga termino (se retira sola a los JOB_DISMISS_MS, la salida
   la anima el CSS con --dismiss). warn: informacion que hay que leer (el
   archivo no es lo buscado, YouTube apagado). err: fallo, con foco programatico
   para que el lector de pantalla lo lea. Los dos ultimos se quedan hasta que se
   cierran. `onClose` ausente = derivado del estado: no se puede cerrar.
   ------------------------------------------------------------------------- */

export default function Strip({ tone, onClose, innerRef, children }) {
  return (
    <div
      className={`strip strip--${tone}`}
      role={tone === "err" ? "alert" : "status"}
      ref={innerRef}
      tabIndex={tone === "err" ? -1 : undefined}
      style={tone === "ok" ? { "--dismiss": `${JOB_DISMISS_MS}ms` } : undefined}
    >
      <Ico n={tone === "ok" ? "check" : "warn"} size={20} />
      <p>{children}</p>
      {onClose && (
        <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar el aviso" onClick={onClose}>
          <Ico n="x" size={16} />
        </button>
      )}
    </div>
  );
}
