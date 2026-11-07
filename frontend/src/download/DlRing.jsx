import { rowKey } from "../shared/api.js";
import Ico from "./ico.jsx";
import { useJob } from "./jobsStore.js";
import { dlState, dlText } from "./searchPlan.js";

/* El estado de descarga de un resultado: el job del jobsStore (solo yt-dlp) y
   los Sets de la pantalla. useJob repinta SOLO esta fila con cada sondeo. */
export function useDl(t, busy, downloaded) {
  return dlState({ busy, job: useJob(rowKey(t)), downloaded });
}

/* ---------------------------------------------------------------------------
   BOTON DE DESCARGA

   Un circulo: bajar en reposo, un anillo con el progreso mientras corre (en
   cola, descargando, procesando), un check al terminar (sigue pulsable para
   volver a bajarlo). El anillo se pinta con --p, que cambia con cada sondeo
   pero no se anima. Ocupado no se deshabilita (aria-disabled): el foco no se
   pierde al pulsar.
   ------------------------------------------------------------------------- */

export default function DlRing({ t, name, busy, downloaded, onDl, small = false }) {
  const s = useDl(t, busy, downloaded);
  const wait = s.id === "queued" || s.id === "down" || s.id === "proc" || s.id === "direct";
  const title = name || t.title || "este resultado";
  const idle = s.id === "idle" || s.id === "err";
  const label = idle ? `Descargar ${title}` : s.id === "done" ? `Descargado: ${title}` : dlText(s);

  return (
    <button
      type="button"
      className={small ? "dlr dlr--sm" : "dlr"}
      data-s={s.id}
      aria-disabled={wait || undefined}
      aria-label={label}
      title={
        idle
          ? s.id === "err"
            ? dlText(s)
            : "Descargar a la biblioteca"
          : s.id === "done"
          ? "Descargado: pulsa para volver a descargarlo"
          : dlText(s)
      }
      style={wait ? { "--p": `${s.pct}%` } : undefined}
      onClick={(e) => !wait && onDl(t, e.currentTarget)}
    >
      {idle ? (
        <Ico n="dl" size={small ? 18 : 22} />
      ) : s.id === "done" ? (
        <Ico n="check" size={small ? 18 : 22} />
      ) : (
        <span className="ring">
          <i />
        </span>
      )}
    </button>
  );
}
