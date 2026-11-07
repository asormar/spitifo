import { NavIcon } from "../app/navIcons.jsx";
import { clock } from "../shared/format.js";
import { Controls, DockArt, Volume } from "./controls.jsx";
import useDock from "./useDock.js";
import Scrub from "./Scrub.jsx";

/* ---------------------------------------------------------------------------
   BARRA DEL REPRODUCTOR (escritorio)

   Cristal flotante abajo, a la derecha del menu lateral. Es la otra vista del
   motor que ve useDock (la del telefono es MiniPlayer): transporte a la
   izquierda, una pantallita "LCD" en el centro (portada, tiempo, titulo,
   tiempo que falta y la barra de progreso pegada al borde de abajo) y silencio,
   volumen y Cola a la derecha. Aparece con una pista y se esconde mientras
   "Ahora suena" o el video estan abiertos.

   La portada abre "Ahora suena"; Cola lo abre en la pagina de la cola.
   ------------------------------------------------------------------------- */

export default function PlayerBar({ onOpen, npOpen }) {
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
          aria-label={`Abrir el reproductor: ${info?.title ?? ""}`}
          title="Abrir el reproductor"
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
        <button type="button" className="cbtn" onClick={() => onOpen(1)} aria-label="Cola" title="Cola">
          <NavIcon name="queue" size={22} />
        </button>
      </div>
    </section>
  );
}
