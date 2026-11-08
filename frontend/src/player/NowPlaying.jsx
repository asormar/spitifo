import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../shared/ui.jsx";
import { clock } from "../shared/format.js";
import { coverTone } from "../shared/cover.js";
import Ico from "../shared/ico.jsx";
import { canStartSwipe, swipeTarget } from "../app/navigation.js";
import { swapPanel } from "../app/screenSwap.js";
import { Icon } from "../listen/icons.jsx";
import { useListen } from "../listen/ListenProvider.jsx";
import QueueList from "../listen/QueueList.jsx";
import { useNotice } from "../listen/Notice.jsx";
import PlaylistPicker from "../listen/PlaylistPicker.jsx";
import { playlists } from "../listen/playlists.js";
import { initial } from "../listen/rows.jsx";
import { useEngine } from "./useEngine.js";
import { useVideoHost } from "./videoStore.js";
import { Controls } from "./controls.jsx";
import Scrub from "./Scrub.jsx";
import NowCards, { FichaCard } from "./NowCards.jsx";
import { sourceCaption, splitMeta } from "./nowInfo.js";
import { panel, usePanel } from "./panel.js";
import { artTint, toneTint } from "./tint.js";
import "./nowplaying.css";

/* ---------------------------------------------------------------------------
   AHORA SUENA

   Vista del reproductor con tres pestanas: Ahora suena, Cola y Ficha. Como el
   mini-reproductor, no tiene estado de reproduccion propio: lee el motor y le
   manda ordenes. Que pestana se ve y si esta abierta lo guarda panel.js.

   Un mismo componente con dos marcos (`mode`, ver panelMode):
   - "full" (telefono): pantalla completa y modal. App la monta dentro de una
     View Transition que la hace crecer desde la pastilla. Un arrastre hacia
     abajo desde la barra o las pestanas la cierra; deslizar el cuerpo de lado
     cambia de pestana al soltar.
   - el resto (escritorio): columna al lado de las paginas ("docked"), o
     ampliada sobre ellas ("wide", solo la pestana Ahora suena), sin gestos, sin
     capturar el foco y sin cerrar nada por si sola. Ampliar y reducir son una
     View Transition (swapPanel): la caja se mueve en el compositor.
   Solo se pinta la pestana a la vista: la cola y sus filas no existen mientras
   no se abre Cola.
   ------------------------------------------------------------------------- */

const TABS = ["Ahora suena", "Cola", "Ficha"];

/* Movimiento minimo antes de decidir si el arrastre es hacia abajo. */
const SLOP = 8;
/* Cierre por arrastre: un cuarto de la altura, o rapido hacia abajo (px/ms). */
const CLOSE_FRACTION = 0.25;
const CLOSE_SPEED = 0.6;

/* Un solo canvas de 24x24 para todas las portadas: promediar 576 pixeles basta
   para el color y no cuesta nada. La portada sale del mismo origen (/api/audio),
   asi que getImageData no esta contaminado; la de un preview (otro origen) lanza
   y se cae al color de genero. */
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

export default function NowPlaying({ mode, onClose, onReveal, onWide }) {
  const pc = mode !== "full";
  const wide = mode === "wide";
  /* Ampliar solo existe en la columna (no flotando sobre Descubrir). */
  const canWide = mode === "docked" || wide;
  /* El deslizamiento de entrada de la columna corre una vez, al montarla (no si
     nace ampliada, y no al volver de ampliada). */
  const [entering, setEntering] = useState(mode === "docked" || mode === "over");
  const track = useEngine((s) => s.track);
  const playing = useEngine((s) => s.playing);
  const engineDuration = useEngine((s) => s.duration);
  const source = useEngine((s) => s.source);
  const tab = usePanel((s) => s.tab);
  /* Solo se anima el cambio de pestana, no la primera pintura. */
  const [seen, setSeen] = useState({ tab, moved: false });
  if (seen.tab !== tab) setSeen({ tab, moved: true });
  const vhost = useVideoHost();
  /* Dentro del proveedor de la biblioteca: de ahi salen los mosaicos de la hoja
     de listas y, en escritorio, el aviso. */
  const listen = useListen();
  /* Portada que ya fallo al cargar: se pinta la ficha con la inicial. */
  const [badArt, setBadArt] = useState(null);
  /* Hoja "Añadir a una lista" abierta. Es una Sheet (z 56, por encima de esta
     capa). En telefono el aviso va dentro de la capa (el de la biblioteca esta
     debajo y no se veria); en escritorio, el de la biblioteca. Esta vista no
     tiene pila de navegacion: la cierra su propio estado. */
  const [adding, setAdding] = useState(false);
  const [noticeNode, showOwn] = useNotice();
  const show = pc ? listen.show : showOwn;

  const rootRef = useRef(null);
  const addRef = useRef(null);
  const bodyRef = useRef(null);
  /* Arrastre de cierre en curso: { id, x, y, mode, dx, dy, v, samples }. */
  const gesture = useRef(null);
  /* Lo que hay que hacer cuando termina la transicion de salida del arrastre. */
  const afterSlide = useRef(null);
  /* Deslizamiento lateral del cuerpo: { x, y, t }. */
  const swipe = useRef(null);

  const meta = track?.meta ?? "";
  const { artist, album } = splitMeta(meta);
  const art = track?.artwork && badArt !== track.artwork ? track.artwork : null;
  const fallback = toneTint(coverTone(artist, album));
  const [paint, apply, settle] = usePaint(art, fallback);

  /* El foco entra en la vista (telefono: la X; escritorio: la pestana activa);
     al cerrar, App lo devuelve a la pastilla o a la barra. */
  useEffect(() => {
    const el = rootRef.current;
    const first = pc ? el.querySelector('[role="tab"][aria-selected="true"]') : el.querySelector(".np__close");
    first?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Cambiar de pestana vuelve arriba. */
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [tab]);

  /* Los fallos de escritura de las listas (que ya deshizo el almacen) se dicen
     en el aviso de aqui; en escritorio ya los dice el de la biblioteca. */
  useEffect(() => (pc ? undefined : playlists.onError(showOwn)), [pc, showOwn]);

  /* Abrir un video (que pausa el audio) deja esta vista sobrando. */
  useEffect(() => {
    if (vhost.mode !== "closed") onClose(false);
  }, [vhost.mode, onClose]);

  /* --- Cierre por arrastre (barra y pestanas, solo telefono) ---------------- */

  const onPointerDown = (e) => {
    /* El raton no arrastra (seleccionaria texto). */
    if (e.pointerType === "mouse" || !e.isPrimary) return;
    gesture.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      mode: null,
      dx: 0,
      dy: 0,
      v: 0,
      samples: [[e.clientY, e.timeStamp]],
    };
  };

  const onPointerMove = (e) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.id) return;
    g.dx = e.clientX - g.x;
    g.dy = e.clientY - g.y;
    if (!g.mode) {
      if (Math.hypot(g.dx, g.dy) < SLOP) return;
      /* Solo cuenta si es claramente hacia abajo. */
      if (g.dy <= 0 || Math.abs(g.dx) > Math.abs(g.dy)) {
        gesture.current = null;
        return;
      }
      g.mode = "y";
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const el = rootRef.current;
    el.style.transition = "none";
    el.style.transform = `translateY(${Math.max(0, g.dy)}px)`;
    g.samples.push([e.clientY, e.timeStamp]);
    if (g.samples.length > 5) g.samples.shift();
    const [y0, t0] = g.samples[0];
    g.v = e.timeStamp > t0 ? (e.clientY - y0) / (e.timeStamp - t0) : 0;
  };

  const runAfterSlide = () => {
    const f = afterSlide.current;
    afterSlide.current = null;
    f?.();
  };

  const release = (cancelled) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || !g.mode) return;
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

  /* --- Cambio de pestana deslizando el cuerpo (solo telefono) ---------------- */

  const onBodyDown = (e) => {
    swipe.current = null;
    if (pc || e.pointerType === "mouse" || !e.isPrimary) return;
    /* Ni el progreso, ni el asa de la cola, ni la hoja de listas. */
    if (!canStartSwipe(e.target) || e.target.closest?.(".sh")) return;
    swipe.current = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  };

  const onBodyUp = (e) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    const to = swipeTarget(
      { dx: e.clientX - s.x, dy: e.clientY - s.y, dt: e.timeStamp - s.t },
      tab,
      TABS.length
    );
    if (to !== null) panel.show(to);
  };

  /* --- Pintado ------------------------------------------------------------ */

  if (!track) return null;

  const duration = engineDuration || track.duration || 0;
  const library = track.kind === "library";
  const caption = sourceCaption(source, track);

  /* Salir de la pestana 0 suelta el ampliado: con su misma transicion. */
  const go = (i) => (wide && i !== 0 ? swapPanel(() => panel.show(i)) : panel.show(i));

  const onTabKey = (e) => {
    const to = { ArrowRight: Math.min(tab + 1, 2), ArrowLeft: Math.max(tab - 1, 0), Home: 0, End: 2 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    go(to);
    e.currentTarget.children[to].focus();
  };

  const tabs = (
    <div
      className="np__tabs"
      role="tablist"
      aria-label={pc ? "Panel del reproductor" : "Vista"}
      onKeyDown={onTabKey}
    >
      {TABS.map((label, i) => (
        <button
          key={label}
          type="button"
          role="tab"
          id={`np-tab-${i}`}
          aria-selected={tab === i}
          aria-controls="np-panel"
          tabIndex={tab === i ? 0 : -1}
          className={cx("np__tab", tab === i && "is-on")}
          onClick={() => go(i)}
        >
          {label}
        </button>
      ))}
    </div>
  );

  const addButton = library && (
    <button
      ref={addRef}
      type="button"
      className="cbtn cbtn--w"
      onClick={() => setAdding(true)}
      aria-label="Añadir a una lista"
      aria-haspopup="dialog"
      title="Añadir a una lista"
    >
      <Ico n="addlist" size={24} />
    </button>
  );

  /* La portada, o la inicial sobre el color de fondo. */
  const cover = art ? (
    <img key={art} className="np__art" src={art} alt="" onError={() => setBadArt(art)} />
  ) : (
    <div className="np__art np__art--ph" aria-hidden="true">
      {initial(artist)}
    </div>
  );

  const title = (
    <>
      <h2 className="np__title">{track.title}</h2>
      <p className="np__sub" title={meta}>
        {meta}
      </p>
    </>
  );

  let panelBody;
  if (tab === 1) {
    panelBody = (
      <div className="np__q">
        <QueueList active scroller={bodyRef} />
      </div>
    );
  } else if (tab === 2) {
    panelBody = (
      <div className="np__file">
        <div className="np__fhead">
          <div className="np__cover np__cover--s">{cover}</div>
          <div className="np__ftx">{title}</div>
        </div>
        {library ? (
          <FichaCard track={track} full onReveal={onReveal} />
        ) : (
          <p className="lnote np__lnote">Este audio es un avance de 30 s: no está en tu biblioteca.</p>
        )}
        <button type="button" className="np__back" onClick={() => panel.show(0)}>
          Volver a la portada
        </button>
      </div>
    );
  } else {
    panelBody = (
      <div className="np__now">
        <div className="np__col">
          <div className="np__cover">{cover}</div>
          {pc ? (
            <div className="np__row">
              <div className="np__meta">{title}</div>
              {addButton}
            </div>
          ) : (
            <div className="np__meta">{title}</div>
          )}
        </div>
        {!pc && (
          <>
            <div className="np__seek">
              <Scrub key={track.key} duration={duration} label={track.label}>
                {(shown) => (
                  <div className="np__times">
                    <span>{clock(shown)}</span>
                    <span>{duration ? `-${clock(duration - shown)}` : "--:--"}</span>
                  </div>
                )}
              </Scrub>
            </div>
            <Controls />
          </>
        )}
        {library && (
          <div className="np__cards">
            <NowCards track={track} artist={artist} onReveal={onReveal} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={cx("np", pc && "np--pane", wide && "np--wide", entering && "np--in", playing && "is-playing")}
      role={pc ? "complementary" : "dialog"}
      aria-modal={pc ? undefined : "true"}
      aria-label="Ahora suena"
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && e.propertyName === "transform") runAfterSlide();
      }}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setEntering(false);
      }}
    >
      {/* El color sale de esta imagen oculta: no depende de que pestana pinta la
          portada. */}
      {art && (
        <img
          key={art}
          hidden
          src={art}
          alt=""
          onLoad={(e) => apply(sample(e.currentTarget) || fallback)}
          onError={() => setBadArt(art)}
        />
      )}
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
        {pc ? (
          <div className="np__head">
            {tabs}
            {canWide && tab === 0 && (
              <button
                type="button"
                className="cbtn cbtn--w np__wide"
                onClick={() => onWide(!wide)}
                aria-label={wide ? "Reducir Ahora suena" : "Ampliar Ahora suena"}
                title={wide ? "Reducir" : "Ampliar"}
              >
                <Ico n={wide ? "collapse" : "expand"} size={20} />
              </button>
            )}
            <button
              type="button"
              className="cbtn cbtn--w np__x"
              onClick={() => onClose()}
              aria-label="Cerrar el panel"
              title="Cerrar el panel"
            >
              <Ico n="x" size={20} />
            </button>
          </div>
        ) : (
          <div
            className="np__head"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => release(false)}
            onPointerCancel={() => release(true)}
          >
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
              <p className="np__cap" title={caption.name}>
                <small>{caption.head}</small>
                <b>{caption.name}</b>
              </p>
              <div className="np__tools">{addButton}</div>
            </header>
            {tabs}
          </div>
        )}

        <div
          ref={bodyRef}
          className="np__body"
          onPointerDown={onBodyDown}
          onPointerUp={onBodyUp}
          onPointerCancel={() => {
            swipe.current = null;
          }}
        >
          <div key={tab} id="np-panel" role="tabpanel" aria-labelledby={`np-tab-${tab}`} className="np__panel" data-rise={seen.moved ? "" : undefined}>
            {panelBody}
          </div>
        </div>
      </div>

      {!pc && noticeNode}

      {adding && (
        <PlaylistPicker
          songKey={track.key}
          title={track.title}
          byKey={listen.model.byKey}
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
