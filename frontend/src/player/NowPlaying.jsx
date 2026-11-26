import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../shared/ui.jsx";
import { coverTone } from "../shared/cover.js";
import { canStartSwipe, swipeTarget } from "../app/navigation.js";
import { Icon } from "../listen/icons.jsx";
import { useListen } from "../listen/ListenProvider.jsx";
import SaveHeart from "../listen/SaveHeart.jsx";
import { fichaText } from "../listen/saveLogic.js";
import { trackPill } from "../listen/fileCheck.js";
import QueueList from "../listen/QueueList.jsx";
import { useNotice } from "../listen/Notice.jsx";
import { useSaved } from "../listen/saved.js";
import { songIdOf } from "../shared/songId.js";
import { playlists } from "../listen/playlists.js";
import { initial } from "../listen/rows.jsx";
import { VerdictChip } from "../shared/Verdict.jsx";
import { engine } from "./engine.js";
import { useEngine } from "./useEngine.js";
import { useVideoHost } from "./videoStore.js";
import { Controls } from "./controls.jsx";
import Scrub from "./Scrub.jsx";
import NowCards, { FichaCard } from "./NowCards.jsx";
import { sourceCaption, splitMeta } from "./nowInfo.js";
import { npLinks } from "./npLinks.js";
import { npMenuKey, npMenuKind } from "./npMenu.js";
import { panel, usePanel } from "./panel.js";
import { playStateText } from "./playState.js";
import { artTint, toneTint } from "./tint.js";
import { resistedDy, scrimOpacity, shouldDismiss, shouldSkip } from "./npGestures.js";
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
     capturar el foco y sin cerrar nada por si sola. Ampliar y reducir cambian
     el marco de golpe y el contenido entra con el mismo fundido de las pestanas.
   Solo se pinta la pestana a la vista: la cola y sus filas no existen mientras
   no se abre Cola.
   ------------------------------------------------------------------------- */

const TABS = ["Ahora suena", "Cola", "Ficha"];

/* Movimiento minimo antes de decidir si el arrastre es hacia abajo. */
const SLOP = 8;

const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Portada de un vecino en el carrusel de deslizar: decorativa (aria-hidden),
   con la misma receta de imagen/inicial que la portada principal pero sin el
   seguimiento de "ya fallo" por cancion (si falla, se queda en la inicial). */
function PeekCover({ track }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [track?.artwork]);
  if (!track) return null;
  const art = track.artwork && !failed ? track.artwork : null;
  if (art) return <img className="np__art" src={art} alt="" onError={() => setFailed(true)} />;
  const { artist } = splitMeta(track.meta || "");
  return (
    <div className="np__art np__art--ph" aria-hidden="true">
      {initial(artist)}
    </div>
  );
}

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

export default function NowPlaying({ mode, onClose, onReveal, onWide, onGo }) {
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
  /* Para el carrusel de deslizar la portada (vecinos que asoman) y la insignia
     de la cola. */
  const queue = useEngine((s) => s.queue);
  const index = useEngine((s) => s.index);
  const repeat = useEngine((s) => s.repeat);
  const tab = usePanel((s) => s.tab);
  /* Solo se anima el cambio de pestana, no la primera pintura. */
  const [seen, setSeen] = useState({ tab, wide, moved: false });
  if (seen.tab !== tab || seen.wide !== wide) setSeen({ tab, wide, moved: true });
  const vhost = useVideoHost();
  /* Dentro del proveedor de la biblioteca: de ahi sale el menu ⋯ de la pista
     y, en escritorio, el aviso. */
  const listen = useListen();
  const savedById = useSaved((s) => s.byId);
  /* Portada que ya fallo al cargar: se pinta la ficha con la inicial. */
  const [badArt, setBadArt] = useState(null);
  /* El aviso propio solo existe para escribir errores de listas en escritorio. */
  const [noticeNode, showOwn] = useNotice();

  const rootRef = useRef(null);
  const bodyRef = useRef(null);
  /* Arrastre de cierre en curso: { id, x, y, mode, dx, dy, v, samples }. */
  const gesture = useRef(null);
  /* Lo que hay que hacer cuando termina la transicion de salida del arrastre. */
  const afterSlide = useRef(null);
  /* Deslizamiento lateral del cuerpo: { x, y, t }. */
  const swipe = useRef(null);
  /* Scrim detras del arrastre de cierre: vive fuera de .np (ver mas abajo), asi
     que el transform de .np no lo arrastra con el. */
  const scrimRef = useRef(null);
  /* Deslizar la portada para saltar: el marco (ancho real) y la pista que se
     arrastra (los tres carteles: vecino anterior, actual, vecino siguiente). */
  const coverFrameRef = useRef(null);
  const coverTrackRef = useRef(null);
  /* Gesto de la portada en curso: { id, x, y, t, started }. */
  const coverGesture = useRef(null);
  /* Flechas fantasma que siguen al dedo durante el deslizamiento. */
  const chevLRef = useRef(null);
  const chevRRef = useRef(null);

  const meta = track?.meta ?? "";
  const { artist, album } = splitMeta(meta);
  const saveHeart = track ? <SaveHeart track={track} /> : null;
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

  /* Vecinos de la cola para el carrusel de deslizar (asoman, no suenan hasta
     que el gesto se confirma). "Anterior" no da la vuelta (como el boton);
     "Siguiente" sí, con repeat "all". */
  const prevNeighbor = index > 0 ? queue[index - 1] : null;
  const nextNeighbor =
    index >= 0 && index + 1 < queue.length
      ? queue[index + 1]
      : repeat === "all" && queue.length
        ? queue[0]
        : null;

  /* Cada cancion nueva recentra el carrusel: sin esto, el ultimo transform del
     arrastre anterior se quedaria pegado sobre la portada que acaba de entrar. */
  useLayoutEffect(() => {
    const el = coverTrackRef.current;
    if (el) {
      el.style.transition = "none";
      el.style.transform = "translateX(0px)";
    }
  }, [track?.key]);

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
    const dx = e.clientX - g.x;
    const rawDy = e.clientY - g.y;
    if (!g.mode) {
      if (Math.hypot(dx, rawDy) < SLOP) return;
      /* Solo cuenta si es claramente hacia abajo. */
      if (rawDy <= 0 || Math.abs(dx) > Math.abs(rawDy)) {
        gesture.current = null;
        return;
      }
      g.mode = "y";
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const el = rootRef.current;
    const h = el.clientHeight;
    /* `g.dy` guarda ya el valor con resistencia (ver npGestures.js): es lo
       que compara release(). */
    g.dy = resistedDy(rawDy, h);
    el.style.transition = "none";
    el.style.transform = `translateY(${Math.max(0, g.dy)}px)`;
    if (scrimRef.current) {
      scrimRef.current.style.transition = "none";
      scrimRef.current.style.opacity = String(scrimOpacity(g.dy, h));
    }
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
    const leave = !cancelled && shouldDismiss(g.dy, g.v, el.clientHeight);
    /* Cerrar sale con la curva de la casa; volver rebota un poco. */
    el.style.transition = `transform var(--t-move) var(${leave ? "--ease" : "--ease-spring"})`;
    el.style.transform = leave ? "translateY(100%)" : "";
    if (scrimRef.current) {
      scrimRef.current.style.transition = `opacity var(--t-move) var(--ease)`;
      scrimRef.current.style.opacity = leave ? "0" : "1";
    }
    afterSlide.current = () => {
      if (leave) onClose(false);
      else el.style.transition = "";
    };
    /* Por si la transicion no llega a emitir su evento. */
    setTimeout(runAfterSlide, 500);
  };

  /* --- Deslizar la portada para saltar de cancion (solo telefono) ----------- */

  const onCoverDown = (e) => {
    if (e.pointerType === "mouse" || !e.isPrimary) return;
    coverGesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, started: false };
  };

  const onCoverMove = (e) => {
    const g = coverGesture.current;
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.started) {
      if (Math.hypot(dx, dy) < SLOP) return;
      /* Mas vertical que horizontal: no es este gesto, que siga el scroll. */
      if (Math.abs(dy) > Math.abs(dx)) {
        coverGesture.current = null;
        return;
      }
      g.started = true;
      g.width = coverFrameRef.current?.clientWidth || 1;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* sin captura, el arrastre sigue igual por los eventos normales */
      }
    }
    const trackEl = coverTrackRef.current;
    if (trackEl) {
      trackEl.style.transition = "none";
      trackEl.style.transform = `translateX(${dx}px)`;
    }
    /* La flecha fantasma del lado hacia el que se desliza, segun cuanto. */
    const op = Math.min(1, Math.abs(dx) / 60);
    const toNext = dx < 0;
    if (chevLRef.current) chevLRef.current.style.opacity = toNext ? "0" : String(op);
    if (chevRRef.current) chevRRef.current.style.opacity = toNext ? String(op) : "0";
  };

  const releaseCover = (e, cancelled) => {
    const g = coverGesture.current;
    coverGesture.current = null;
    const trackEl = coverTrackRef.current;
    if (chevLRef.current) chevLRef.current.style.opacity = "0";
    if (chevRRef.current) chevRRef.current.style.opacity = "0";
    if (!g || !trackEl) return;
    if (!g.started) return;
    const dx = cancelled ? 0 : e.clientX - g.x;
    const dt = Math.max(1, e.timeStamp - g.t);
    const v = Math.abs(dx) / dt;
    const dir = dx < 0 ? 1 : -1; // izquierda => siguiente
    const neighbor = dir > 0 ? nextNeighbor : prevNeighbor;
    const commit = Boolean(neighbor) && !cancelled && shouldSkip(dx, v, g.width);
    const reduced = prefersReducedMotion();
    const dur = reduced ? 0 : 320;
    trackEl.style.transition = dur ? `transform ${dur}ms var(--drawer)` : "none";
    if (commit) {
      trackEl.style.transform = `translateX(${-dir * g.width}px)`;
      const go = () => (dir > 0 ? engine.next() : engine.prev());
      if (dur) setTimeout(go, dur);
      else go();
    } else {
      trackEl.style.transform = "translateX(0px)";
    }
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
  const id = songIdOf(track.result);
  const savedStream = Boolean(
    (track.sid && listen.model.savedById.has(track.sid)) ||
      (id && listen.model.savedById.has(id))
  );
  const ficha = fichaText({
    kind: track.kind,
    source: track.result?.source || track.source,
    saved: savedStream,
    sid: track.sid,
  });
  /* Chip discreto: como suena y si la cancion esta en la biblioteca. Cuando el
     archivo tiene un veredicto (una pista de biblioteca comprobada, o un
     avance de 30 s) el marcador de verificacion lo sustituye: es el
     diferenciador del producto y va junto al titulo, con las mismas palabras
     y tokens que el resto de la app. */
  const stateText = playStateText({ kind: track.kind, saved: savedStream });
  const stateChip = stateText && (
    <span className="np__state">
      {library && <Icon name="Check" size="sm" className="np__state-check" />}
      {stateText}
    </span>
  );
  const pill = trackPill(track, library ? listen.model.byKey.get(track.key) : null);
  const marker = pill ? (
    <VerdictChip v={pill} onOpen={() => panel.show(2)} className="np__verdict" />
  ) : (
    stateChip
  );
  /* El menu ⋯ reusa el de Tu biblioteca cuando la pista tiene entrada (archivo
     o cancion guardada). Un stream suelto cae a los grupos de Buscar. */
  const record = track.sid ? savedById.get(track.sid) : null;
  const menuKey = npMenuKey({
    library,
    byKey: listen.model.byKey,
    record,
    key: track.key,
    sid: track.sid,
  });
  const menuKind = npMenuKind({ byKey: listen.model.byKey, record, result: track.result, menuKey });
  const openMore = (e) => {
    const anchor = e.currentTarget;
    if (menuKind === "menu") {
      listen.ctx.openMenu(menuKey, anchor, "menu", { closePlayer: true });
    } else if (menuKind === "npmenu") {
      listen.ctx.openMenu(menuKey, anchor, "npmenu", { t: track.result, closePlayer: true });
    }
  };
  /* El artista y el album llevan a sus paginas (npLinks.js). */
  const links = npLinks(track, library ? listen.model.byKey.get(track.key) : null);
  const named = (text, link) =>
    link && onGo && link.name === text ? (
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          onGo(link);
        }}
      >
        {text}
      </a>
    ) : (
      text
    );
  const caption = sourceCaption(source, track);

  /* Salir de la pestana 0 suelta el ampliado: con su misma transicion. */
  const go = (i) => panel.show(i);

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

  /* Un solo boton para abrir el menu ⋯, en las dos cabeceras. Solo se pinta
     si hay un menu detras: la cancion de la biblioteca o un resultado al que
     le quepa el menu de Ahora suena. Nunca queda inerte. */
  const hasMenu = listen.model.byKey.has(menuKey) || Boolean(record) || Boolean(track.result);
  const moreButton = hasMenu ? (
    <button
      type="button"
      className="np__more"
      onClick={openMore}
      aria-label={`Más opciones de ${track.title}`}
      aria-haspopup="menu"
      title="Más opciones"
    >
      <Icon name="DotsThree" size="lg" />
    </button>
  ) : null;

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
        {/* Sin entrada ni resultado no hay partes: el artista va como texto. */}
        {(links.artists.length ? links.artists : [{ name: artist, sep: "", link: null }]).map((p, i) => (
          <Fragment key={i}>
            {p.sep || null}
            {named(p.name, p.link)}
          </Fragment>
        ))}
        {album && <> · {named(album, links.album)}</>}
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
        ) : ficha?.note ? (
          <p className="lnote np__lnote">{ficha.note}</p>
        ) : ficha ? (
          <section className="ncard" aria-label="Ficha del audio">
            <h3 className="ncard__h">Ficha del audio</h3>
            <p className="ncard__p">{ficha.where}</p>
            <p className="ncard__p">{ficha.saved}</p>
            {ficha.link && (
              <button
                type="button"
                className="ncard__go"
                onClick={() => onReveal(track.sid || track.key)}
              >
                Ver en tu biblioteca
              </button>
            )}
          </section>
        ) : null}
        <button type="button" className="np__back" onClick={() => panel.show(0)}>
          Volver a la portada
        </button>
      </div>
    );
  } else {
    panelBody = (
      <div className="np__now">
        <div className="np__col">
          <div ref={coverFrameRef} className="np__cover">
            {pc ? (
              cover
            ) : (
              <div
                ref={coverTrackRef}
                className="np__cover-track"
                data-no-swipe=""
                onPointerDown={onCoverDown}
                onPointerMove={onCoverMove}
                onPointerUp={(e) => releaseCover(e, false)}
                onPointerCancel={(e) => releaseCover(e, true)}
              >
                <div className="np__cover-item np__cover-item--prev" aria-hidden="true">
                  <PeekCover track={prevNeighbor} />
                </div>
                <div className="np__cover-item">{cover}</div>
                <div className="np__cover-item np__cover-item--next" aria-hidden="true">
                  <PeekCover track={nextNeighbor} />
                </div>
              </div>
            )}
            {!pc && (
              <>
                <span ref={chevLRef} className="np__cover-chev np__cover-chev--l" aria-hidden="true">
                  <Icon name="CaretLeft" size="sm" />
                </span>
                <span ref={chevRRef} className="np__cover-chev np__cover-chev--r" aria-hidden="true">
                  <Icon name="CaretLeft" size="sm" />
                </span>
              </>
            )}
          </div>
          {pc ? (
            <div className="np__row">
              <div className="np__meta">
                {title}
                {marker}
              </div>
              {saveHeart}
            </div>
          ) : (
            <div className="np__meta np__meta--v">
              <div className="np__tx">
                {title}
                {marker}
              </div>
              {saveHeart}
            </div>
          )}
        </div>
        {library && (
          <div className="np__cards">
            <NowCards artist={artist} trackKey={track.key} />
          </div>
        )}
      </div>
    );
  }

  /* Transporte del telefono: fijo fuera del scroll (flex:none, debajo de
     np__body), asi reproducir y saltar siguen al alcance aunque la portada,
     el estado o las tarjetas no quepan en un telefono bajo. Solo en Ahora
     suena: en Cola y Ficha el cuerpo vuelve a ocupar todo el alto. */
  const transport = !pc && tab === 0 && (
    <div className="np__transport">
      <div className="np__seek">
        <Scrub key={track.key} duration={duration} label={track.label}>
          {({ elapsedRef, remainingRef }) => (
            <div className="np__times">
              <span ref={elapsedRef} />
              <span ref={remainingRef} />
            </div>
          )}
        </Scrub>
      </div>
      <Controls />
    </div>
  );

  return (
    <>
      {/* Fuera de .np: si viviera dentro, el transform del arrastre de cierre
          lo arrastraria con la tarjeta en vez de dejarlo fijo detras. */}
      {!pc && <div ref={scrimRef} className="np__scrim" aria-hidden="true" />}
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
            <div className="np__pane-tools">
              {canWide && tab === 0 && (
                <button
                  type="button"
                  className="cbtn cbtn--w np__wide"
                  onClick={() => onWide(!wide)}
                  aria-label={wide ? "Reducir Ahora suena" : "Ampliar Ahora suena"}
                  title={wide ? "Reducir" : "Ampliar"}
                >
                  <Icon name={wide ? "ArrowsIn" : "ArrowsOut"} size="md" />
                </button>
              )}
              {moreButton}
              <button
                type="button"
                className="cbtn cbtn--w np__x"
                onClick={() => onClose()}
                aria-label="Cerrar el panel"
                title="Cerrar el panel"
              >
                <Icon name="X" size="md" />
              </button>
            </div>
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
                <Icon name="CaretDown" size="lg" />
              </button>
              <p className="np__cap" title={caption.name}>
                <small>{caption.head}</small>
                <b>{caption.name}</b>
              </p>
              <div className="np__tools">{moreButton}</div>
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
          <div key={wide ? "w" : tab} id="np-panel" role="tabpanel" aria-labelledby={`np-tab-${tab}`} className="np__panel" data-rise={seen.moved ? "" : undefined}>
            {panelBody}
          </div>
        </div>

        {transport}
      </div>

      {!pc && noticeNode}
      </div>
    </>
  );
}
