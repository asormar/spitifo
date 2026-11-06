import { Icon } from "../shared/icons.jsx";
import { cx } from "../shared/ui.jsx";
import { coverTone, toneClass, toneVars } from "../shared/cover.js";
import { initial } from "../listen/rows.jsx";
import { engine } from "./engine.js";
import useDock from "./useDock.js";
import Scrub from "./Scrub.jsx";

/* ---------------------------------------------------------------------------
   MINI-REPRODUCTOR (telefono)

   Pastilla de cristal flotante sobre la barra inferior. Es una vista del
   motor, como las filas: no tiene <audio> propio. Se ve siempre que hay una
   pista (ver useDock.js y dock.js), en cualquier pestana; la X la pausa y la
   esconde hasta la siguiente pista.

   Tocar la portada o el titulo abre "Ahora suena" (onOpen); mientras esta
   abierta la pastilla se oculta, porque esa vista ya es el reproductor.
   ------------------------------------------------------------------------- */

function MiniPlayer({ onOpen, npOpen }) {
  const d = useDock(npOpen);
  const { info, show } = d;
  const meta = info?.meta ?? "";
  const at = meta.indexOf(" · ");
  const artist = at < 0 ? meta : meta.slice(0, at);
  const tone = coverTone(artist, at < 0 ? "" : meta.slice(at + 3));

  return (
    <section
      className={cx("mini", d.playing && "is-playing")}
      aria-label="Reproductor"
      data-state={show ? "open" : "closed"}
      data-no-swipe=""
      aria-hidden={show ? undefined : true}
      inert={show ? undefined : ""}
    >
      <div className="mini__row">
        {/* Tocar la portada o el titulo abre "Ahora suena", como en cualquier
            app de musica. */}
        <button
          type="button"
          className="mini__txt"
          onClick={onOpen}
          aria-label={`Abrir el reproductor: ${info?.title ?? ""}`}
        >
          {d.art ? (
            <img className="mini__art" src={d.art} alt="" loading="lazy" onError={d.onArtError} />
          ) : (
            <span
              className={cx("cv mini__art", toneClass(tone))}
              style={{ ...toneVars(tone), "--s": "44px" }}
              aria-hidden="true"
            >
              <span>{initial(artist || info?.title)}</span>
            </span>
          )}
          <span className="mini__tx">
            <span className="mini__title" title={info?.title}>
              {info?.title}
            </span>
            <span className="mini__meta" title={meta}>
              {meta}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="pbtn"
          data-icon={d.icon}
          onClick={() => engine.toggle()}
          aria-label={`${d.playing ? "Pausar" : "Reproducir"} ${d.label}`}
        >
          <span className="pbtn__ico pbtn__ico--play">
            <Icon name="Play" size={18} weight="fill" />
          </span>
          <span className="pbtn__ico pbtn__ico--pause">
            <Icon name="Pause" size={18} weight="fill" />
          </span>
          <span className="pbtn__ico pbtn__ico--load">
            <Icon name="CircleNotch" size={18} weight="bold" className="spin" />
          </span>
        </button>
        <button
          type="button"
          className="mini__btn"
          onClick={() => engine.next()}
          disabled={!d.hasNext}
          aria-label="Siguiente"
          title="Siguiente"
        >
          <Icon name="SkipForward" size={20} weight="fill" />
        </button>
        <button
          type="button"
          className="mini__btn"
          onClick={d.close}
          aria-label="Cerrar reproductor"
          title="Cerrar reproductor"
        >
          <Icon name="X" size={18} />
        </button>
      </div>
      {/* Hilo de progreso en el borde de abajo; tambien se puede arrastrar. */}
      <div className="mini__bar">
        <Scrub key={info?.key} duration={d.dur} label={d.label} />
      </div>
    </section>
  );
}

export default MiniPlayer;
