import Ico from "../shared/ico.jsx";
import { clock } from "../shared/format.js";
import { cx } from "../shared/ui.jsx";
import { VerdictChip } from "../shared/Verdict.jsx";
import { Controls, DockArt, Volume } from "./controls.jsx";
import useDock from "./useDock.js";
import { useTrackPill } from "./useTrackPill.js";
import Scrub from "./Scrub.jsx";

/* ---------------------------------------------------------------------------
   BARRA DEL REPRODUCTOR (escritorio)

   Cristal flotante abajo, a la derecha del menu lateral. Es la otra vista del
   motor que ve useDock (la del telefono es MiniPlayer): transporte a la
   izquierda, una pantallita "LCD" en el centro (portada, tiempo, titulo,
   tiempo que falta y la barra de progreso pegada al borde de abajo) y silencio,
   volumen, Cola y Ficha a la derecha. Aparece con una pista y se esconde
   mientras el video esta abierto; la columna de "Ahora suena" no la tapa (la
   barra es su transporte).

   La pastilla de veredicto de la pista abre la Ficha (no la alterna). La
   portada abre "Ahora suena". Cola y Ficha abren su pestana y son
   interruptores: `tab` es la pestana que se ve (-1 = ninguna) y pulsar la que
   esta a la vista cierra la columna (onOpen(tab, true)).
   ------------------------------------------------------------------------- */

export default function PlayerBar({ onOpen, npOpen, tab = -1 }) {
  const d = useDock(npOpen);
  const { info, show, meta } = d;
  const pill = useTrackPill(info);

  return (
    <section
      className="dock"
      aria-label="Reproductor"
      data-state={show ? "open" : "closed"}
      aria-hidden={show ? undefined : true}
      inert={show ? undefined : ""}
    >
      <Controls dock />

      <div className="lcd">
        <button
          type="button"
          className="lcd__cv"
          onClick={() => onOpen(0)}
          aria-label={`Abrir Ahora suena: ${info?.title ?? ""}`}
          title="Abrir Ahora suena"
        >
          <DockArt d={d} size={40} className="lcd__art" />
        </button>
        <Scrub key={info?.key} duration={d.dur} label={d.label}>
          {(shown) => (
            <>
              <span className="lcd__time">{clock(shown)}</span>
              <span className="lcd__tx">
                <span className="lcd__t" title={info?.title}>
                  {info?.title}
                </span>
                <span className="lcd__s" title={meta}>
                  {meta}
                </span>
              </span>
              <span className="lcd__time lcd__time--r">
                {d.dur ? `-${clock(d.dur - shown)}` : "--:--"}
              </span>
            </>
          )}
        </Scrub>
        {pill && <VerdictChip v={pill} className="lcd__v" onOpen={() => onOpen(2)} />}
      </div>

      <div className="dock__end">
        <Volume className="dock__vol" />
        {[
          [1, "Cola", "queue"],
          [2, "Ficha del archivo", "file"],
        ].map(([i, label, n]) => (
          <button
            key={i}
            type="button"
            className={cx("cbtn cbtn--tab", tab === i && "is-open")}
            onClick={() => onOpen(i, true)}
            aria-pressed={tab === i}
            aria-label={label}
            title={label}
          >
            <Ico n={n} size={22} />
          </button>
        ))}
      </div>
    </section>
  );
}
