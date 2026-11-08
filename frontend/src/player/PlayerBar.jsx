import Ico from "../shared/ico.jsx";
import { clock } from "../shared/format.js";
import { cx } from "../shared/ui.jsx";
import { Controls, DockArt, Volume } from "./controls.jsx";
import useDock from "./useDock.js";
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

   La portada abre "Ahora suena". Cola y Ficha abren su pestana y son
   interruptores: `tab` es la pestana que se ve (-1 = ninguna) y pulsar la que
   esta a la vista cierra la columna (onOpen(tab, true)).
   ------------------------------------------------------------------------- */

export default function PlayerBar({ onOpen, npOpen, tab = -1 }) {
  const d = useDock(npOpen);
  const { info, show, meta } = d;

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
      </div>

      <div className="dock__end">
        <Volume className="dock__vol" />
        <button
          type="button"
          className={cx("cbtn cbtn--tab", tab === 1 && "is-open")}
          onClick={() => onOpen(1, true)}
          aria-pressed={tab === 1}
          aria-label="Cola"
          title="Cola"
        >
          <Ico n="queue" size={22} />
        </button>
        <button
          type="button"
          className={cx("cbtn cbtn--tab", tab === 2 && "is-open")}
          onClick={() => onOpen(2, true)}
          aria-pressed={tab === 2}
          aria-label="Ficha del archivo"
          title="Ficha del archivo"
        >
          <Ico n="file" size={22} />
        </button>
      </div>
    </section>
  );
}
