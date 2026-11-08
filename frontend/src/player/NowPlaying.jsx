import { useCallback, useEffect, useRef, useState } from "react";
import { cx } from "../shared/ui.jsx";
import { clock } from "../shared/format.js";
import { Icon } from "../listen/icons.jsx";
import QueueList from "../listen/QueueList.jsx";
import { useNotice } from "../listen/Notice.jsx";
import PlaylistPicker from "../listen/PlaylistPicker.jsx";
import { playlists } from "../listen/playlists.js";
import { initial } from "../listen/rows.jsx";
import { useEngine } from "./useEngine.js";
import { useVideoHost } from "./videoStore.js";
import { usePc } from "../shared/viewport.js";
import { Controls, Volume } from "./controls.jsx";
import Scrub from "./Scrub.jsx";
import { artTint, fallbackTint } from "./tint.js";
import "./nowplaying.css";

/* ---------------------------------------------------------------------------
   AHORA SUENA

   Vista a pantalla completa del reproductor. Como el mini-reproductor, no
   tiene estado de reproduccion propio: lee el motor y le manda ordenes. App la
   monta solo mientras esta abierta, dentro de una View Transition que la hace
   crecer desde la pastilla (ver screenSwap.js y nowplaying.css).

   En telefono son dos paginas en una banda horizontal (Ahora suena y Cola) que
   se cambian con las pastillas o deslizando; en escritorio (usePc) van lado a
   lado. Un arrastre hacia abajo cierra la vista. Los gestos usan pointer events: el
   gesto se decide por la direccion de los primeros pixeles y, una vez
   decidido, la vista captura el puntero.
   ------------------------------------------------------------------------- */

const PAGES = ["Ahora suena", "Cola"];

/* Movimiento minimo antes de decidir si el gesto es horizontal o vertical. */
const SLOP = 8;
/* Cierre por arrastre: un cuarto de la altura, o rapido hacia abajo (px/ms). */
const CLOSE_FRACTION = 0.25;
const CLOSE_SPEED = 0.6;
/* Cambio de pagina por arrastre horizontal (px). */
const PAGE_DRAG = 60;

/* Un solo canvas de 24x24 para todas las portadas: promediar 576 pixeles basta
   para el color y no cuesta nada. La portada sale del mismo origen (/api/audio),
   asi que getImageData no esta contaminado; la de un preview (otro origen) lanza
   y se cae al color del artista. */
let probe = null;
function sample(img) {
  try {
    probe ||= document.createElement("canvas");
    probe.width = 24;
    probe.height = 24;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 24, 24);
    return artTint(ctx.getImageData(0, 0, 24, 24).data);
  } catch {
    return null;
  }
}

/* Color de fondo de la pista. Al cambiar, el anterior queda debajo (`prev`) y
   el nuevo se funde encima: nunca se anima background-color. Con portada, el
   color anterior se mantiene hasta que la imagen carga, asi hay un solo
   fundido por cancion. */
function usePaint(art, fallback) {
  const [paint, setPaint] = useState({ cur: art ? null : fallback, prev: null });
  const apply = useCallback(
    (css) => setPaint((p) => (p.cur === css ? p : { cur: css, prev: p.cur })),
    []
  );
  useEffect(() => {
    if (!art) apply(fallback);
  }, [art, fallback, apply]);
  const settle = useCallback(() => setPaint((p) => (p.prev ? { ...p, prev: null } : p)), []);
  return [paint, apply, settle];
}

export default function NowPlaying({ onClose, onReveal, initialPage = 0 }) {
  const track = useEngine((s) => s.track);
  const engineDuration = useEngine((s) => s.duration);
  const vhost = useVideoHost();
  const wide = usePc();
  /* Pagina con la que abre: la cola si viene de "Cola" de la barra. */
  const [page, setPage] = useState(initialPage);
  /* Portada que ya fallo al cargar: se pinta la ficha con la inicial. */
  const [badArt, setBadArt] = useState(null);
  /* Hoja "Añadir a una lista" abierta. Es una Sheet (z 56, por encima de esta
     capa); el aviso va dentro de la capa: el de la biblioteca esta debajo y no
     se veria. Esta vista no tiene pila de navegacion: la cierra su propio estado. */
  const [adding, setAdding] = useState(false);
  const [noticeNode, show] = useNotice();

  const rootRef = useRef(null);
  const addRef = useRef(null);
  const pagesRef = useRef(null);
  const trackRef = useRef(null);
  const queueRef = useRef(null);
  /* Gesto en curso: { id, x, y, mode, dx, dy, v, samples, inQueue }. */
  const gesture = useRef(null);
  /* Lo que hay que hacer cuando termina la transicion de salida del arrastre. */
  const afterSlide = useRef(null);

  const meta = track?.meta ?? "";
  const at = meta.indexOf(" · ");
  const artist = at < 0 ? meta : meta.slice(0, at);
  const album = at < 0 ? "" : meta.slice(at + 3);
  const art = track?.artwork && badArt !== track.artwork ? track.artwork : null;
  const fallback = fallbackTint(artist);
  const [paint, apply, settle] = usePaint(art, fallback);

  /* El foco entra en la vista; al cerrar, App lo devuelve a la pastilla. */
  useEffect(() => {
    rootRef.current.querySelector(".np__close").focus({ preventScroll: true });
  }, []);

  useEffect(() => playlists.onError(show), [show]);

  /* Abrir un video (que pausa el audio) deja esta vista sobrando. */
  useEffect(() => {
    if (vhost.mode !== "closed") onClose(false);
  }, [vhost.mode, onClose]);

  /* --- Gestos ------------------------------------------------------------- */

  const onPointerDown = (e) => {
    /* El raton no arrastra (seleccionaria texto); la barra, el volumen, el asa
       de la cola y la hoja de listas tienen su propio gesto. */
    if (e.pointerType === "mouse" || !e.isPrimary) return;
    if (e.target.closest(".scrub, input, .qrow__grip, .sh")) return;
    gesture.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      mode: null,
      dx: 0,
      dy: 0,
      v: 0,
      samples: [[e.clientY, e.timeStamp]],
      inQueue: Boolean(e.target.closest(".np__qs")),
    };
  };

  const onPointerMove = (e) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.id) return;
    g.dx = e.clientX - g.x;
    g.dy = e.clientY - g.y;
    if (!g.mode) {
      if (Math.hypot(g.dx, g.dy) < SLOP) return;
      /* Solo cuenta si es claramente de un eje. En la cola, el vertical es del
         scroll de la lista; en pantalla ancha no hay paginas que deslizar. */
      const horizontal = Math.abs(g.dx) > Math.abs(g.dy);
      g.mode = horizontal ? (wide ? "none" : "x") : g.dy > 0 && !g.inQueue ? "y" : "none";
      if (g.mode === "none") {
        gesture.current = null;
        return;
      }
      rootRef.current.setPointerCapture(e.pointerId);
    }
    if (g.mode === "x") {
      const w = pagesRef.current.clientWidth;
      const x = Math.min(0, Math.max(-w, -page * w + g.dx));
      trackRef.current.style.transition = "none";
      trackRef.current.style.transform = `translateX(${x}px)`;
    } else {
      const el = rootRef.current;
      el.style.transition = "none";
      el.style.transform = `translateY(${Math.max(0, g.dy)}px)`;
      g.samples.push([e.clientY, e.timeStamp]);
      if (g.samples.length > 5) g.samples.shift();
      const [y0, t0] = g.samples[0];
      g.v = e.timeStamp > t0 ? (e.clientY - y0) / (e.timeStamp - t0) : 0;
    }
  };

  const release = (cancelled) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || !g.mode) return;
    if (g.mode === "x") {
      trackRef.current.style.transition = "";
      trackRef.current.style.transform = "";
      if (!cancelled && g.dx < -PAGE_DRAG) setPage(1);
      else if (!cancelled && g.dx > PAGE_DRAG) setPage(0);
      return;
    }
    const el = rootRef.current;
    const leave = !cancelled && (g.dy > el.clientHeight * CLOSE_FRACTION || g.v > CLOSE_SPEED);
    /* Cerrar sale con la curva de la casa; volver rebota un poco. */
    el.style.transition = `transform var(--t-move) var(${leave ? "--ease" : "--ease-spring"})`;
    el.style.transform = leave ? "translateY(100%)" : "";
    afterSlide.current = () => {
      if (leave) onClose(false);
      else el.style.transition = "";
    };
    /* Por si la transicion no llega a emitir su evento. */
    setTimeout(runAfterSlide, 500);
  };
  const runAfterSlide = () => {
    const f = afterSlide.current;
    afterSlide.current = null;
    f?.();
  };

  /* --- Pintado ------------------------------------------------------------ */

  if (!track) return null;

  const duration = engineDuration || track.duration || 0;
  const caption = album || artist;
  const inPage = (i) => (!wide && page !== i ? "" : undefined);

  const onTabKey = (e) => {
    const to = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? 0 : null;
    if (to === null) return;
    e.preventDefault();
    setPage(to);
    e.currentTarget.children[to].focus();
  };

  return (
    <div
      ref={rootRef}
      className="np"
      role="dialog"
      aria-modal="true"
      aria-label="Ahora suena"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => release(false)}
      onPointerCancel={() => release(true)}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && e.propertyName === "transform") runAfterSlide();
      }}
    >
      {paint.prev && <div key={paint.prev} className="np__bg" style={{ "--tint": paint.prev }} />}
      {paint.cur && (
        <div
          key={paint.cur}
          className={cx("np__bg", paint.prev && "np__bg--in")}
          style={{ "--tint": paint.cur }}
          onAnimationEnd={settle}
        />
      )}

      <div className="np__ui">
        <header className="np__top">
          <button
            type="button"
            className="np__close"
            onClick={() => onClose()}
            aria-label="Cerrar"
            title="Cerrar"
          >
            <Icon name="CaretDown" size={26} />
          </button>
          <p className="np__cap" title={caption}>
            {caption}
          </p>
          <div className="np__tools">
            {track.kind === "library" && (
              <button
                ref={addRef}
                type="button"
                className="cbtn cbtn--w"
                onClick={() => setAdding(true)}
                aria-label="Añadir a una lista"
                aria-haspopup="dialog"
                title="Añadir a una lista"
              >
                <Icon name="Plus" size={24} />
              </button>
            )}
            <button
              type="button"
              className="np__go"
              disabled={track.kind !== "library"}
              onClick={() => onReveal(track.key)}
            >
              Ver en tu biblioteca
            </button>
          </div>
        </header>

        {!wide && (
          <div className="np__tabs" role="tablist" aria-label="Vista" onKeyDown={onTabKey}>
            {PAGES.map((label, i) => (
              <button
                key={label}
                type="button"
                role="tab"
                id={`np-tab-${i}`}
                aria-selected={page === i}
                aria-controls={`np-page-${i}`}
                tabIndex={page === i ? 0 : -1}
                className={cx("np__tab", page === i && "is-on")}
                onClick={() => setPage(i)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div ref={pagesRef} className="np__pages" data-page={wide ? undefined : page}>
          <div ref={trackRef} className="np__track">
            <section
              id="np-page-0"
              className="np__now"
              role="tabpanel"
              aria-label={PAGES[0]}
              inert={inPage(0)}
            >
              <div className="np__artbox">
                {art ? (
                  <img
                    key={art}
                    className="np__art"
                    src={art}
                    alt=""
                    onLoad={(e) => apply(sample(e.currentTarget) || fallback)}
                    onError={() => setBadArt(art)}
                  />
                ) : (
                  <div className="np__art np__art--ph" aria-hidden="true">
                    {initial(artist)}
                  </div>
                )}
              </div>
              <div className="np__meta">
                <h2 className="np__title">{track.title}</h2>
                <p className="np__sub" title={meta}>
                  {meta}
                </p>
              </div>
              <div className="np__seek">
                <Scrub key={track.key} duration={duration} label={track.label}>
                  {(shown, total) => (
                    <div className="np__times">
                      <span>{clock(shown)}</span>
                      <span>{total}</span>
                    </div>
                  )}
                </Scrub>
              </div>
              <Controls />
              {wide && <Volume />}
            </section>

            <section
              id="np-page-1"
              className="np__q"
              role="tabpanel"
              aria-label={PAGES[1]}
              inert={inPage(1)}
            >
              <div ref={queueRef} className="np__qs">
                <QueueList active scroller={queueRef} />
              </div>
            </section>
          </div>
        </div>
      </div>

      {noticeNode}

      {adding && (
        <PlaylistPicker
          songKey={track.key}
          title={track.title}
          onNotice={show}
          onClose={() => {
            setAdding(false);
            addRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}
