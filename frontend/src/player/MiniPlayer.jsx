import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../shared/icons.jsx";
import { cx } from "../shared/ui.jsx";
import { clock } from "../shared/format.js";
import { engine } from "./engine.js";
import { useEngine } from "./useEngine.js";
import { useVideoHost } from "./videoStore.js";
import Scrub from "./Scrub.jsx";

/* ---------------------------------------------------------------------------
   MINI-REPRODUCTOR

   La musica sigue sonando al cambiar de pantalla o al hacer scroll, pero
   entonces la cancion que suena queda sin controles: su fila esta en otro modo
   o fuera de pantalla. Esta pastilla fija los devuelve. No tiene <audio>
   propio: es una vista del motor, como las filas, asi que no hay una segunda
   fuente de verdad que pueda desincronizarse.

   Solo se ve cuando hace falta: hay una cancion empezada Y su fila no esta a
   la vista (no esta montada, esta fuera del viewport o su pantalla esta
   oculta). Con la fila delante, los controles duplicados sobrarian. Si el
   usuario la cierra, se queda cerrada hasta la siguiente pista o el siguiente
   play.

   Tocar el titulo o la portada abre "Ahora suena" (onOpen); mientras esta
   abierta la pastilla se oculta, porque esa vista ya es el reproductor.
   ------------------------------------------------------------------------- */

const NO_ROWS = [];

function MiniPlayer({ onReveal, onOpen, npOpen }) {
  const st = useEngine();
  const [dismissed, setDismissed] = useState(false);
  /* true hasta que el IntersectionObserver diga lo contrario: mejor tardar un
     fotograma en aparecer que parpadear con la fila aun a la vista. */
  const [srcSeen, setSrcSeen] = useState(true);
  /* Portada que ya fallo al cargar: no se vuelve a pintar (icono roto). */
  const [badArt, setBadArt] = useState(null);
  const lastInfo = useRef(null);
  const vhost = useVideoHost();

  const track = st.track;
  /* El motor no suelta la pista al terminar la cola, pero se guarda la ultima
     igual: si algun dia lo hace, el texto no se vacia mientras la pastilla se
     desvanece. */
  if (track) lastInfo.current = track;
  const info = track || lastInfo.current;
  const srcEls = track ? engine.elementsFor(track.key) : NO_ROWS;

  /* Otro destino = otra cancion: la pastilla vuelve a ofrecerse. */
  useEffect(() => {
    setDismissed(false);
  }, [track?.key]);

  /* Y reproducir tambien la reabre (reanudar desde la fila). */
  useEffect(() => {
    if (st.playing) setDismissed(false);
  }, [st.playing]);

  /* Se observan las cajas de las filas de origen, no el audio: la cancion puede
     estar en varias pantallas (alguna oculta) y basta con que se vea una. Sin
     fila montada no esta a la vista. */
  useLayoutEffect(() => {
    if (!srcEls.length || typeof IntersectionObserver === "undefined") {
      setSrcSeen(false);
      return undefined;
    }
    setSrcSeen(true);
    const seen = new Set();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) seen.add(e.target);
          else seen.delete(e.target);
        }
        setSrcSeen(seen.size > 0);
      },
      { threshold: 0 }
    );
    srcEls.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [srcEls]);

  const started = st.playing || st.time > 0;
  /* Con un video abierto el audio ya esta pausado: la pastilla solo estorbaria
     encima de la ventana del video. */
  const show =
    !!track &&
    started &&
    !dismissed &&
    !srcSeen &&
    !npOpen &&
    vhost.mode === "closed";

  /* Reserva sitio en la pagina y aparta los avisos de descarga (CSS). */
  useEffect(() => {
    document.body.classList.toggle("has-mini", show);
    return () => document.body.classList.remove("has-mini");
  }, [show]);

  const dur = st.duration || info?.duration || 0;
  const icon = st.buffering ? "load" : st.playing ? "pause" : "play";
  const label = info?.label || "la canción";
  const quiet = st.muted || st.volume === 0;
  const volPct = Math.round((quiet ? 0 : st.volume) * 100);
  const art = info?.artwork && badArt !== info.artwork ? info.artwork : null;
  const hasNext = st.index >= 0 && st.index + 1 < st.queue.length;
  /* "Ir a la cancion" abre Escuchar: un preview de una tarjeta no esta en la
     biblioteca y no habria fila a la que llevar. */
  const inLibrary = track?.kind === "library";

  const close = () => {
    engine.pause();
    setDismissed(true);
  };

  return (
    <section
      className={cx("mini", st.playing && "is-playing")}
      aria-label="Reproductor"
      data-state={show ? "open" : "closed"}
      data-no-swipe=""
      aria-hidden={show ? undefined : true}
      inert={show ? undefined : ""}
    >
      <div className="mini__row">
        {/* Anterior y siguiente: se puede cambiar de tema sin volver a la lista. */}
        <button
          type="button"
          className="mini__btn mini__btn--prev"
          onClick={() => engine.prev()}
          aria-label="Anterior"
          title="Anterior"
        >
          <Icon name="SkipBack" size={16} weight="fill" />
        </button>
        <button
          type="button"
          className="pbtn"
          data-icon={icon}
          onClick={() => engine.toggle()}
          aria-label={`${st.playing ? "Pausar" : "Reproducir"} ${label}`}
        >
          <span className="pbtn__ico pbtn__ico--play">
            <Icon name="Play" size={16} weight="fill" />
          </span>
          <span className="pbtn__ico pbtn__ico--pause">
            <Icon name="Pause" size={16} weight="fill" />
          </span>
          <span className="pbtn__ico pbtn__ico--load">
            <Icon name="CircleNotch" size={16} weight="bold" className="spin" />
          </span>
        </button>
        <button
          type="button"
          className="mini__btn mini__btn--next"
          onClick={() => engine.next()}
          disabled={!hasNext}
          aria-label="Siguiente"
          title="Siguiente"
        >
          <Icon name="SkipForward" size={16} weight="fill" />
        </button>
        {art && (
          <img
            className="mini__art"
            src={art}
            alt=""
            loading="lazy"
            onClick={onOpen}
            onError={() => setBadArt(art)}
          />
        )}
        {/* Tocar el titulo (o la portada) abre "Ahora suena", como en cualquier
            app de musica. Ir a la fila de la biblioteca es el boton de la mira;
            en movil se oculta para que el titulo quepa y ese salto vive en
            "Ahora suena". */}
        <button
          type="button"
          className="mini__txt"
          onClick={onOpen}
          aria-label={`Abrir el reproductor: ${info?.title ?? ""}`}
        >
          <span className="mini__title" title={info?.title}>
            {info?.title}
          </span>
          <span className="mini__meta" title={info?.meta}>
            {info?.meta}
          </span>
        </button>
        {/* Silencio siempre; el deslizador solo con raton y pantalla ancha (CSS).
            En tactil manda el volumen del telefono. */}
        <div className="mini__vol">
          <button
            type="button"
            className="pl__mute"
            onClick={() => engine.toggleMute()}
            aria-label={quiet ? "Activar el sonido" : "Silenciar"}
          >
            {quiet ? (
              <Icon name="SpeakerSlash" size={17} />
            ) : st.volume < 0.45 ? (
              <Icon name="SpeakerLow" size={17} />
            ) : (
              <Icon name="SpeakerHigh" size={17} />
            )}
          </button>
          <input
            type="range"
            className="vol"
            min={0}
            max={100}
            step={1}
            value={volPct}
            aria-label="Volumen"
            style={{ "--v": `${volPct}%` }}
            onChange={(e) => engine.setVolume(Number(e.target.value) / 100)}
          />
        </div>
        <button
          type="button"
          className="mini__btn mini__btn--reveal"
          onClick={() => onReveal(track.key)}
          disabled={!inLibrary}
          aria-label="Ir a la canción"
          title="Ir a la canción"
        >
          <Icon name="Crosshair" size={18} />
        </button>
        <button
          type="button"
          className="mini__btn"
          onClick={close}
          aria-label="Cerrar reproductor"
          title="Cerrar reproductor"
        >
          <Icon name="X" size={18} />
        </button>
      </div>
      <div className="mini__bar">
        <Scrub key={info?.key} duration={dur} label={label}>
          {(shown, total) => (
            <span className="mini__time">
              {clock(shown)} / {total}
            </span>
          )}
        </Scrub>
      </div>
    </section>
  );
}

export default MiniPlayer;
