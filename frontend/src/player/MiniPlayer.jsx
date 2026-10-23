import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CircleNotch,
  Crosshair,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerLow,
  SpeakerSlash,
  X,
} from "@phosphor-icons/react";
import { cx, clamp } from "../shared/ui.jsx";
import { clock } from "../shared/format.js";
import { engine } from "./engine.js";
import { useEngine } from "./useEngine.js";
import { useVideoHost } from "./videoStore.js";

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
   ------------------------------------------------------------------------- */

function MiniPlayer({ onReveal }) {
  const st = useEngine();
  const [dismissed, setDismissed] = useState(false);
  /* true hasta que el IntersectionObserver diga lo contrario: mejor tardar un
     fotograma en aparecer que parpadear con la fila aun a la vista. */
  const [srcSeen, setSrcSeen] = useState(true);
  const [drag, setDrag] = useState(null);
  /* Portada que ya fallo al cargar: no se vuelve a pintar (icono roto). */
  const [badArt, setBadArt] = useState(null);
  const railRef = useRef(null);
  const lastInfo = useRef(null);
  const vhost = useVideoHost();

  const track = st.track;
  /* El motor no suelta la pista al terminar la cola, pero se guarda la ultima
     igual: si algun dia lo hace, el texto no se vacia mientras la pastilla se
     desvanece. */
  if (track) lastInfo.current = track;
  const info = track || lastInfo.current;
  const srcEl = track ? engine.elementFor(track.key) : null;

  /* Otro destino = otra cancion: la pastilla vuelve a ofrecerse. */
  useEffect(() => {
    setDismissed(false);
    setDrag(null);
  }, [track?.key]);

  /* Y reproducir tambien la reabre (reanudar desde la fila). */
  useEffect(() => {
    if (st.playing) setDismissed(false);
  }, [st.playing]);

  /* Se observa la caja de la fila de origen, no el audio. Sin fila montada
     (srcEl null) no esta a la vista. */
  useLayoutEffect(() => {
    if (!srcEl || typeof IntersectionObserver === "undefined") {
      setSrcSeen(false);
      return undefined;
    }
    setSrcSeen(true);
    const io = new IntersectionObserver(([e]) => setSrcSeen(e.isIntersecting), {
      threshold: 0,
    });
    io.observe(srcEl);
    return () => io.disconnect();
  }, [srcEl]);

  const started = st.playing || st.time > 0;
  /* Con un video abierto el audio ya esta pausado: la pastilla solo estorbaria
     encima de la ventana del video. */
  const show =
    !!track &&
    started &&
    !dismissed &&
    !srcSeen &&
    vhost.mode === "closed";

  /* Reserva sitio en la pagina y aparta los avisos de descarga (CSS). */
  useEffect(() => {
    document.body.classList.toggle("has-mini", show);
    return () => document.body.classList.remove("has-mini");
  }, [show]);

  const dur = st.duration || info?.duration || 0;
  const pct = drag !== null ? drag : dur ? clamp(st.time / dur, 0, 1) : 0;
  const shownTime = drag !== null ? drag * dur : st.time;
  const total = dur ? clock(Math.round(dur)) : "--:--";
  const icon = st.buffering ? "load" : st.playing ? "pause" : "play";
  const label = info?.label || "la canción";
  const quiet = st.muted || st.volume === 0;
  const volPct = Math.round((quiet ? 0 : st.volume) * 100);
  const art = info?.artwork && badArt !== info.artwork ? info.artwork : null;
  const hasNext = st.index >= 0 && st.index + 1 < st.queue.length;
  /* "Ir a la cancion" abre Escuchar: un preview de una tarjeta no esta en la
     biblioteca y no habria fila a la que llevar. */
  const inLibrary = track?.kind === "library";

  const seekTo = (t) => {
    engine.seek(clamp(t, 0, dur || 0));
  };

  const pctAt = (e) => {
    const r = railRef.current.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };
  const onPointerDown = (e) => {
    if (!dur) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(pctAt(e));
  };
  const onPointerMove = (e) => {
    if (drag !== null) setDrag(pctAt(e));
  };
  const onPointerUp = (e) => {
    if (drag === null) return;
    seekTo(pctAt(e) * dur);
    setDrag(null);
  };
  const onKeyDown = (e) => {
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      /* Del motor: seek() actualiza su foto, asi que las flechas repetidas
         suman aunque React no haya repintado entre una y otra. */
      engine.seek(engine.getState().time + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      seekTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      seekTo(dur - 1);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      engine.toggle();
    }
  };

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
          <SkipBack size={16} weight="fill" />
        </button>
        <button
          type="button"
          className="pbtn"
          data-icon={icon}
          onClick={() => engine.toggle()}
          aria-label={`${st.playing ? "Pausar" : "Reproducir"} ${label}`}
        >
          <span className="pbtn__ico pbtn__ico--play">
            <Play size={16} weight="fill" />
          </span>
          <span className="pbtn__ico pbtn__ico--pause">
            <Pause size={16} weight="fill" />
          </span>
          <span className="pbtn__ico pbtn__ico--load">
            <CircleNotch size={16} weight="bold" className="spin" />
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
          <SkipForward size={16} weight="fill" />
        </button>
        {art && (
          <img
            className="mini__art"
            src={art}
            alt=""
            loading="lazy"
            onError={() => setBadArt(art)}
          />
        )}
        {/* Tocar el titulo lleva a la cancion, como en cualquier app de musica.
            En movil es el UNICO camino (el boton de la mira se oculta para que
            el titulo quepa); fuera del orden de tabulacion porque con teclado
            ya esta ese boton. */}
        <button
          type="button"
          className="mini__txt"
          tabIndex={-1}
          onClick={() => onReveal(track.key)}
          disabled={!inLibrary}
          aria-label={`Ir a la canción: ${info?.title ?? ""}`}
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
              <SpeakerSlash size={17} />
            ) : st.volume < 0.45 ? (
              <SpeakerLow size={17} />
            ) : (
              <SpeakerHigh size={17} />
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
          <Crosshair size={18} />
        </button>
        <button
          type="button"
          className="mini__btn"
          onClick={close}
          aria-label="Cerrar reproductor"
          title="Cerrar reproductor"
        >
          <X size={18} />
        </button>
      </div>
      <div className="mini__bar">
        <div
          ref={railRef}
          className={cx("scrub", drag !== null && "is-drag")}
          role="slider"
          tabIndex={0}
          aria-label={`Progreso de ${label}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct * 100)}
          aria-valuetext={`${clock(shownTime)} de ${total}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDrag(null)}
          onKeyDown={onKeyDown}
        >
          <span className="scrub__rail">
            <span className="scrub__fill" style={{ transform: `scaleX(${pct})` }} />
          </span>
          <span className="scrub__knob" style={{ left: `${pct * 100}%` }} />
        </div>
        <span className="mini__time">
          {clock(shownTime)} / {total}
        </span>
      </div>
    </section>
  );
}

export default MiniPlayer;
