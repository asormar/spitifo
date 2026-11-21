import { lazy, Suspense } from "react";
import { cx } from "../shared/ui.jsx";
import SaveHeart from "../listen/SaveHeart.jsx";
import { DockArt, PlayButton } from "./controls.jsx";
import useDock from "./useDock.js";
import Scrub from "./Scrub.jsx";

/* El texto de streaming no se carga hasta que suena una pista de ese tipo: no
   pesa en el primer pintado de la app. */
const StreamBadge = lazy(() => import("./StreamBits.jsx").then((m) => ({ default: m.StreamBadge })));

/* ---------------------------------------------------------------------------
   MINI-REPRODUCTOR (telefono)

   Pastilla de cristal flotante sobre la barra inferior. Es una vista del
   motor, como las filas: no tiene <audio> propio. Como en Spotify, solo lleva
   portada/titulo, el corazon de la pista y reproducir/pausar; la descarga,
   Siguiente y "Cerrar reproductor" viven en el menu de "Ahora suena". No hay
   gesto de deslizar: la pastilla es data-no-swipe y el gesto horizontal del
   cuerpo no nace aqui.

   Tocar la portada o el titulo abre "Ahora suena" (onOpen); mientras esta
   abierta la pastilla se oculta, porque esa vista ya es el reproductor.
   ------------------------------------------------------------------------- */

function MiniPlayer({ onOpen, npOpen }) {
  const d = useDock(npOpen);
  const { info, show, meta } = d;
  /* El corazon se oculta solo cuando la pista no se puede guardar (un avance). */
  const saveHeart = info ? <SaveHeart track={info} className="mini__heart" /> : null;

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
        <PlayButton icon={d.icon} playing={d.playing} label={d.label} size={18} />
      </div>
      {/* Hilo de progreso en el borde de abajo; tambien se puede arrastrar. */}
      <div className="mini__bar">
        <Scrub key={info?.key} duration={d.dur} label={d.label} />
      </div>
    </section>
  );
}

export default MiniPlayer;
