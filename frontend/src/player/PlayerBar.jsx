import { lazy, Suspense } from "react";
import { Icon } from "../shared/icons.jsx";
import { cx } from "../shared/ui.jsx";
import { VerdictChip } from "../shared/Verdict.jsx";
import { Controls, DockArt, Volume } from "./controls.jsx";
import useDock from "./useDock.js";
import { useTrackPill } from "./useTrackPill.js";
import Scrub from "./Scrub.jsx";
import { usePanel } from "./panel.js";

const StreamBadge = lazy(() => import("./StreamBits.jsx").then((m) => ({ default: m.StreamBadge })));
/* Como en la pastilla: el corazon y todo su registro de guardadas esperan a
   que suene una pista. `.lcd .shrt` reserva el sitio mientras carga. */
const SaveHeart = lazy(() => import("../listen/SaveHeart.jsx"));

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

export default function PlayerBar({ onOpen, npOpen, tab }) {
  /* La pestana la lee aqui, no en App: asi cambiar de Cola a Ficha no
     reconstruye todo el shell por encima de la barra. */
  const panelOpen = usePanel((s) => s.open);
  const panelTab = usePanel((s) => s.tab);
  const activeTab = tab === undefined ? (panelOpen ? panelTab : -1) : tab;
  const d = useDock(npOpen);
  const { info, show, meta } = d;
  const pill = useTrackPill(info);
  const saveHeart = info ? (
    <Suspense fallback={<span className="shrt" aria-hidden="true" />}>
      <SaveHeart track={info} />
    </Suspense>
  ) : null;

  return (
    <section
      className="dock"
      aria-label="Reproductor"
      data-state={show ? "open" : "closed"}
      aria-hidden={show ? undefined : true}
      inert={!show}
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
          {({ elapsedRef, remainingRef }) => (
            <>
              <span className="lcd__time" ref={elapsedRef} />
              <span className="lcd__tx">
                <span className="lcd__line">
                  <span className="lcd__t" title={info?.title}>
                    {info?.title}
                  </span>
                  {saveHeart}
                </span>
                <span className="lcd__s" title={meta}>
                  {info?.kind === "stream" && !d.failed && (
                    <>
                      <Suspense fallback={null}><StreamBadge track={info} /></Suspense>{" "}
                    </>
                  )}
                  {d.status}
                </span>
              </span>
              <span className="lcd__time lcd__time--r" ref={remainingRef} />
            </>
          )}
        </Scrub>
        {pill && <VerdictChip v={pill} className="lcd__v" onOpen={() => onOpen(2)} />}
      </div>

      <div className="dock__end">
        <Volume className="dock__vol" />
        {[
          [1, "Cola", "Queue"],
          [2, "Ficha del archivo", "File"],
        ].map(([i, label, name]) => (
          <button
            key={i}
            type="button"
            className={cx("cbtn cbtn--tab", activeTab === i && "is-open")}
            onClick={() => onOpen(i, true)}
            aria-pressed={activeTab === i}
            aria-label={label}
            title={label}
          >
            <Icon name={name} size="lg" />
          </button>
        ))}
      </div>
    </section>
  );
}
