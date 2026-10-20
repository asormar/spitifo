import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import {
  CircleNotch,
  Crosshair,
  Pause,
  Play,
  SpeakerHigh,
  SpeakerLow,
  SpeakerSlash,
  X,
} from "@phosphor-icons/react";
import { cx, clamp } from "../shared/ui.jsx";
import { clock } from "../shared/format.js";
import {
  audioMeta,
  current,
  setSharedVolume,
  shared,
  toggleSharedMute,
  watchers,
} from "./engine.js";

/* ---------------------------------------------------------------------------
   MINI-REPRODUCTOR

   La biblioteca ya no se desmonta al cerrarse (la musica sigue), pero entonces
   la cancion que suena queda sin controles: su fila esta oculta, o fuera de
   pantalla a mitad de scroll. Esta pastilla fija los devuelve. No tiene
   <audio> propio: se cuelga del elemento `current` y lo gobierna directamente,
   asi no hay una segunda fuente de verdad que pueda desincronizarse.

   Solo se ve cuando hace falta: hay una cancion empezada Y su Player no esta a
   la vista (cajon cerrado o fuera del viewport). Con la fila delante, los
   controles duplicados sobrarian. Si el usuario la cierra, se queda cerrada
   hasta el siguiente `play`.
   ------------------------------------------------------------------------- */

const MINI_IDLE = { playing: false, buffering: false, time: 0, dur: 0 };

function MiniPlayer({ libOpen, onReveal }) {
  const [, repaint] = useReducer((n) => n + 1, 0);
  const [st, setSt] = useState(MINI_IDLE);
  const [dismissed, setDismissed] = useState(false);
  /* true hasta que el IntersectionObserver diga lo contrario: mejor tardar un
     fotograma en aparecer que parpadear con la fila aun a la vista. */
  const [srcSeen, setSrcSeen] = useState(true);
  const [drag, setDrag] = useState(null);
  /* Portada que ya fallo al cargar: no se vuelve a pintar (icono roto). */
  const [badArt, setBadArt] = useState(null);
  const railRef = useRef(null);
  const lastInfo = useRef(null);

  useEffect(() => {
    watchers.add(repaint);
    return () => watchers.delete(repaint);
  }, []);

  const audio = current;
  const meta = audio ? audioMeta.get(audio) : null;
  /* Al desmontarse el Player se pierde su registro; se recuerda el ultimo para
     que el texto no se vacie mientras la pastilla se desvanece. */
  if (meta) lastInfo.current = meta;
  const info = meta || lastInfo.current;
  const srcEl = meta?.el ?? null;

  /* Espejo del estado del <audio> con sus eventos nativos. Layout effect: al
     cambiar de cancion el estado viejo no llega a pintarse. */
  useLayoutEffect(() => {
    setDismissed(false);
    setDrag(null);
    if (!audio) {
      setSt(MINI_IDLE);
      return undefined;
    }
    const sync = (buffering) =>
      setSt((p) => {
        const n = {
          playing: !audio.paused,
          buffering: buffering ?? p.buffering,
          time: audio.currentTime || 0,
          dur: Number.isFinite(audio.duration) ? audio.duration : 0,
        };
        return n.playing === p.playing &&
          n.buffering === p.buffering &&
          n.time === p.time &&
          n.dur === p.dur
          ? p
          : n;
      });
    const handlers = {
      play: () => {
        setDismissed(false);
        sync(audio.readyState < 3);
      },
      playing: () => sync(false),
      pause: () => sync(false),
      ended: () => sync(false),
      waiting: () => sync(true),
      emptied: () => sync(false),
      timeupdate: () => sync(),
      durationchange: () => sync(),
      loadedmetadata: () => sync(),
    };
    Object.entries(handlers).forEach(([n, h]) => audio.addEventListener(n, h));
    sync(!audio.paused && audio.readyState < 3);
    return () => {
      Object.entries(handlers).forEach(([n, h]) => audio.removeEventListener(n, h));
    };
  }, [audio]);

  /* Se observa la caja del Player de origen, no el audio. */
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

  /* Con el cajon cerrado el IO tambien lo detecta (el recorte deja la fila en
     0), pero solo cuando termina de cerrarse. Esto lo adelanta al clic. */
  const inClosedDrawer = !libOpen && !!srcEl?.closest(".drawer");
  const started = st.playing || st.time > 0;
  const show = !!audio && started && !dismissed && (!srcSeen || inClosedDrawer);

  /* Reserva sitio en la pagina y aparta los avisos de descarga (CSS). */
  useEffect(() => {
    document.body.classList.toggle("has-mini", show);
    return () => document.body.classList.remove("has-mini");
  }, [show]);

  /* Teclas multimedia, auriculares y pantalla de bloqueo. Progresivo: sin la
     API no pasa nada. Los try/catch son porque cada navegador soporta un
     subconjunto de acciones y las que no conoce lanzan en vez de ignorarse. */
  useEffect(() => {
    if (!("mediaSession" in navigator) || !audio || !info) return undefined;
    const ms = navigator.mediaSession;
    try {
      if (typeof MediaMetadata !== "undefined") {
        ms.metadata = new MediaMetadata({
          title: info.title || "",
          artist: info.meta || "",
          /* Solo las filas de resultados traen portada; las de la biblioteca
             no, y ahi se omite en vez de mandar una lista vacia. */
          ...(info.artwork ? { artwork: [{ src: info.artwork, sizes: "300x300" }] } : {}),
        });
      }
    } catch {
      /* los metadatos son opcionales */
    }
    const actions = {
      play: () => audio.play().catch(() => {}),
      pause: () => audio.pause(),
      seekto: (d) => {
        if (typeof d?.seekTime === "number") audio.currentTime = d.seekTime;
      },
    };
    Object.entries(actions).forEach(([n, h]) => {
      try {
        ms.setActionHandler(n, h);
      } catch {
        /* accion no soportada */
      }
    });
    return () => {
      Object.keys(actions).forEach((n) => {
        try {
          ms.setActionHandler(n, null);
        } catch {
          /* idem */
        }
      });
      ms.metadata = null;
    };
  }, [audio, info]);

  const dur = st.dur || info?.duration || 0;
  const pct = drag !== null ? drag : dur ? clamp(st.time / dur, 0, 1) : 0;
  const shownTime = drag !== null ? drag * dur : st.time;
  const total = dur ? clock(Math.round(dur)) : "--:--";
  const icon = st.buffering ? "load" : st.playing ? "pause" : "play";
  const label = info?.label || "la canción";
  /* Leidos de `shared` en cada pintado: los watchers repintan al cambiar. */
  const quiet = shared.muted || shared.volume === 0;
  const volPct = Math.round((quiet ? 0 : shared.volume) * 100);
  const art = info?.artwork && badArt !== info.artwork ? info.artwork : null;

  const toggle = () => {
    if (!audio) return;
    if (audio.paused) {
      audio.volume = shared.volume;
      audio.muted = shared.muted;
      setSt((p) => ({ ...p, buffering: true }));
      /* Igual que en Player: AbortError no es un fallo del audio. */
      audio.play().catch(() => setSt((p) => ({ ...p, buffering: false })));
    } else {
      audio.pause();
    }
  };

  const seekTo = (t) => {
    const v = clamp(t, 0, dur || 0);
    if (audio && dur) audio.currentTime = v;
    setSt((p) => ({ ...p, time: v }));
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
      seekTo((audio?.currentTime ?? st.time) + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      seekTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      seekTo(dur - 1);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle();
    }
  };

  const close = () => {
    audio?.pause();
    setDismissed(true);
  };

  return (
    <section
      className={cx("mini", st.playing && "is-playing")}
      aria-label="Reproductor"
      data-state={show ? "open" : "closed"}
      aria-hidden={show ? undefined : true}
      inert={show ? undefined : ""}
    >
      <div className="mini__row">
        <button
          type="button"
          className="pbtn"
          data-icon={icon}
          onClick={toggle}
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
          onClick={() => onReveal(srcEl)}
          disabled={!srcEl}
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
            onClick={toggleSharedMute}
            aria-label={quiet ? "Activar el sonido" : "Silenciar"}
          >
            {quiet ? (
              <SpeakerSlash size={17} />
            ) : shared.volume < 0.45 ? (
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
            onChange={(e) => setSharedVolume(Number(e.target.value) / 100)}
          />
        </div>
        <button
          type="button"
          className="mini__btn mini__btn--reveal"
          onClick={() => onReveal(srcEl)}
          disabled={!srcEl}
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
