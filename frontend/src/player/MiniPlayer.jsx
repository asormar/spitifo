import { lazy, Suspense } from "react";
import { cx } from "../shared/ui.jsx";
import { Icon } from "../shared/icons.jsx";
import { DockArt, PlayButton } from "./controls.jsx";
import { engine } from "./engine.js";
import { useEngine } from "./useEngine.js";
import useDock from "./useDock.js";
import Scrub from "./Scrub.jsx";

/* El texto de streaming no se carga hasta que suena una pista de ese tipo: no
   pesa en el primer pintado de la app. */
const StreamBadge = lazy(() => import("./StreamBits.jsx").then((m) => ({ default: m.StreamBadge })));
/* El corazon trae el registro de guardadas, la cola y sus hojas: solo se carga
   cuando suena una pista. Mientras llega, el hueco lo reserva `.mini .shrt`
   (CSS del shell), asi la pastilla no se mueve. */
const SaveHeart = lazy(() => import("../listen/SaveHeart.jsx"));

/* ---------------------------------------------------------------------------
   MINI-REPRODUCTOR (telefono)

   Pastilla de cristal flotante sobre la barra inferior. Es una vista del
   motor, como las filas: no tiene <audio> propio. Lleva portada/titulo, el
   corazon de la pista, Siguiente y reproducir/pausar; la descarga y "Cerrar
   reproductor" viven en el menu de "Ahora suena". No hay gesto de deslizar: la
   pastilla es data-no-swipe y el gesto horizontal del cuerpo no nace aqui.

   Tocar la portada o el titulo abre "Ahora suena" (onOpen); mientras esta
   abierta la pastilla se oculta, porque esa vista ya es el reproductor.
   ------------------------------------------------------------------------- */

function MiniPlayer({ onOpen, npOpen }) {
  const d = useDock(npOpen);
  const { info, show, meta } = d;
  /* Como en Controls: ¿hay a donde saltar? (cola o repetir todo). */
  const canNext = useEngine((s) => (s.index >= 0 && s.index + 1 < s.queue.length) || s.repeat === "all");
  /* El corazon se oculta solo cuando la pista no se puede guardar (un avance). */
  const saveHeart = info ? (
    <Suspense fallback={<span className="shrt" aria-hidden="true" />}>
      <SaveHeart track={info} />
    </Suspense>
  ) : null;

  return (
    <section
      className={cx("mini", d.playing && "is-playing")}
      aria-label="Reproductor"
      data-state={show ? "open" : "closed"}
      data-no-swipe=""
      aria-hidden={show ? undefined : true}
      inert={!show}
    >
      <div className="mini__row">
        {/* Tocar la portada o el titulo abre "Ahora suena", como en cualquier
            app de musica. */}
        <button
          type="button"
          className="mini__txt"
          onClick={() => onOpen()}
          aria-label={`Abrir el reproductor: ${info?.title ?? ""}`}
        >
          <DockArt d={d} size={44} className="mini__art" />
          <span className="mini__tx">
            <span className="mini__title" title={info?.title}>
              {info?.title}
            </span>
            <span className="mini__meta" title={meta}>
              {info?.kind === "stream" && !d.failed && (
                <>
                  <Suspense fallback={null}><StreamBadge track={info} /></Suspense>{" "}
                </>
              )}
              {d.status}
            </span>
          </span>
        </button>
        {saveHeart}
        <button
          type="button"
          className="cbtn mini__next"
          onClick={() => engine.next()}
          disabled={!canNext}
          aria-label="Siguiente"
          title="Siguiente"
        >
          <Icon name="SkipForward" size="md" weight="fill" />
        </button>
        <PlayButton icon={d.icon} playing={d.playing} label={d.label} size="md" />
      </div>
      {/* Hilo de progreso en el borde de abajo; tambien se puede arrastrar. */}
      <div className="mini__bar">
        <Scrub key={info?.key} duration={d.dur} label={d.label} />
      </div>
    </section>
  );
}

export default MiniPlayer;
