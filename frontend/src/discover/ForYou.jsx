import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cx, useSlidingPill } from "../shared/ui.jsx";
import { listDrag, panelDecision, pickSnap, resist, sheetGeometry, snapName, tabDecision } from "./gestures.js";
import { PANEL_ROOM, PANEL_W, startsCollapsed } from "./frame.js";
import { Icon } from "./icons.jsx";
import { PanelTitle, panelHead } from "./ForYouSlot.jsx";
import { normalize } from "./map.js";
import { reco, useReco, visibleArtists } from "./reco.js";
import { useDrag } from "./useDrag.js";
import { ArtistRow, GenresTab, StateBlock } from "./ForYouLists.jsx";
import "./foryou.css";

/* ---------------------------------------------------------------------------
   PARA TI

   El panel de recomendaciones de Descubrir, dentro del mapa. En pantalla
   estrecha es una hoja inferior con tres paradas (barra, mitad, completa) que
   se arrastra con dedo o raton; en ancha, un panel flotante de 360 px que se
   recoge a una pestana. Este archivo es el marco y sus gestos; las filas y los
   estados estan en ForYouLists.jsx y la matematica de los gestos en
   gestures.js.

   La hoja y el panel se mueven con transform escrito directo sobre el nodo
   mientras dura el arrastre (nada se renderiza 60 veces por segundo); al
   soltar se fija la parada y React la conoce.
   ------------------------------------------------------------------------- */

const NONE = new Set();
/* Lo que dura una fila saliendo: desliza (--t-quick) y luego se pliega (--t-enter). */
const EXIT_MS = 380;
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Que se muestra cuando no hay filas. */
function emptyKind({ rec, hiddenCount }) {
  if (rec.status.running) return "warm";
  if (hiddenCount > 0) return "hidden";
  if (rec.status.offline) return "offline";
  if (rec.error && !rec.ready) return "error";
  if (!rec.ready) return "loading";
  return "empty";
}

export default function ForYou({
  data,
  idx,
  mine,
  explore,
  ctx,
  notify,
  onFocus,
  onPreview,
  onSearch,
  onPlayArtist,
  onPlayGenre,
  initialCollapsed = false,
}) {
  const rec = useReco();
  const { narrow, box, genreOpen, setObstacle } = ctx;

  const [tab, setTab] = useState("art");
  const [selName, setSelName] = useState(null);
  const [menu, setMenu] = useState(null);
  const [leaving, setLeaving] = useState(NONE);
  const [busy, setBusy] = useState(null);
  const [snap, setSnap] = useState("peek");
  /* El hueco (ForYouSlot) ya decidio si el panel lateral nace recogido. */
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  const segsRef = useRef(null);
  const listRef = useRef(null);
  const sheetRef = useRef(null);
  const sideRef = useRef(null);
  const peekRef = useRef(null);
  const pillRef = useRef(null);
  const refocus = useRef(false);
  const exits = useRef(new Map());
  const snapRef = useRef(snap);
  snapRef.current = snap;
  /* La pastilla se vuelve a medir si el marco cambia (hoja <-> panel). */
  useSlidingPill(segsRef, `${tab}${narrow}`);

  /* --- Datos de las filas -------------------------------------------------- */

  const artists = useMemo(() => visibleArtists(rec.artists, rec.hidden), [rec.artists, rec.hidden]);
  const rows = useMemo(
    () =>
      artists.map((a) => {
        const gidx = a.genres.map((n) => idx.get(normalize(n)) ?? -1);
        return { ...a, gidx, gi: gidx.filter((i) => i >= 0) };
      }),
    [artists, idx]
  );
  const kind = emptyKind({ rec, hiddenCount: rec.hidden.length });
  const head = panelHead(rec);

  /* --- Fila elegida: anillo fuerte en el mapa y vuelo al primer genero ------ */

  const sel = rows.find((r) => r.name === selName) || null;
  const focusKey = sel ? sel.gi.join(",") : "";
  const focusSet = useMemo(() => (focusKey ? new Set(sel.gi) : NONE), [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    onFocus(focusSet);
  }, [focusSet, onFocus]);
  useEffect(
    () => () => {
      onFocus(NONE);
      onPreview(NONE);
    },
    [onFocus, onPreview]
  );

  const select = (row) => {
    setMenu(null);
    if (selName === row.name) {
      setSelName(null);
      return;
    }
    setSelName(row.name);
    if (row.gi.length) ctx.flyTo(row.gi[0]);
  };

  const preview = useCallback(
    (row) => onPreview(row && row.gi.length ? new Set(row.gi) : NONE),
    [onPreview]
  );

  /* --- Muestras ------------------------------------------------------------- */

  const play = async (key, name, fetcher) => {
    if (busy) return;
    setMenu(null);
    setBusy(key);
    try {
      const count = await fetcher(name);
      if (!count) notify(`No hay muestras de ${name}.`);
    } catch {
      notify(`No se pudo buscar la muestra de ${name}.`);
    } finally {
      setBusy(null);
    }
  };

  /* --- "No me interesa": sale la fila, aviso con Deshacer ------------------- */

  const stopExit = (name) => {
    clearTimeout(exits.current.get(name));
    exits.current.delete(name);
    setLeaving((s) => {
      const next = new Set(s);
      next.delete(name);
      return next;
    });
  };

  const hide = (name) => {
    if (exits.current.has(name)) return;
    setMenu(null);
    setSelName((n) => (n === name ? null : n));
    setLeaving((s) => new Set(s).add(name));
    exits.current.set(
      name,
      setTimeout(
        () => {
          stopExit(name);
          reco.dismiss(name);
        },
        reduced() ? 0 : EXIT_MS
      )
    );
    notify(`Ocultado ${name}.`, {
      label: "Deshacer",
      run: () => {
        /* Si aun esta saliendo, basta con cancelarlo; si no, se deshace en el servidor. */
        if (exits.current.has(name)) stopExit(name);
        else reco.undo(name);
      },
    });
  };

  /* Lo que estaba saliendo al desmontar se confirma: el gesto no se pierde. */
  useEffect(() => {
    const pending = exits.current;
    return () => {
      pending.forEach((timer, name) => {
        clearTimeout(timer);
        reco.dismiss(name);
      });
      pending.clear();
    };
  }, []);

  /* --- Menu de fila: se cierra al tocar fuera ------------------------------- */

  useEffect(() => {
    if (!menu) return undefined;
    const away = (e) => {
      if (!e.target.closest(".fy-menu, .fy-more")) setMenu(null);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [menu]);

  const menuPick = (row, what) => {
    setMenu(null);
    if (what === "search") onSearch(row.name);
    else hide(row.name);
  };

  /* --- Geometria y obstaculo ------------------------------------------------ */

  const geo = useMemo(() => sheetGeometry(box.h || 600), [box.h]);
  const geoRef = useRef(geo);
  geoRef.current = geo;

  /* Que parte del mapa tapa el panel: la camara encuadra en lo que queda. */
  useEffect(() => {
    if (narrow) setObstacle({ bottom: geo.heights[snap] + 8 });
    else setObstacle({ right: collapsed ? 0 : PANEL_ROOM });
  }, [narrow, snap, collapsed, geo, setObstacle]);
  useEffect(() => () => setObstacle({}), [setObstacle]);

  /* En ancho estrecho (pero no telefono) el panel empieza recogido: lo decide
     el hueco al nacer; si nacio en telefono se decide al pasar a ancho. */
  const decided = useRef(!narrow);
  useEffect(() => {
    if (decided.current || narrow || !box.w) return;
    decided.current = true;
    if (startsCollapsed(box.w, false)) setCollapsed(true);
  }, [box.w, narrow]);

  /* --- Hoja inferior (pantalla estrecha) ------------------------------------ */

  const goSnap = (name) => {
    /* Con la tarjeta de un genero abierta, abrir la hoja la cierra: las dos
       viven abajo y no caben a la vez. */
    if (name !== "peek" && genreOpen) ctx.closeGenre();
    setSnap(name);
  };

  /* La tarjeta de un genero manda: la hoja se recoge a la barra. */
  useEffect(() => {
    if (narrow && genreOpen) setSnap("peek");
  }, [narrow, genreOpen]);

  /* Solo un cambio de parada se anima; nacer o cambiar de tamano, no. */
  const placed = useRef(null);
  useLayoutEffect(() => {
    const el = sheetRef.current;
    if (!el) {
      placed.current = null;
      return;
    }
    if (el.dataset.drag !== undefined) return;
    const still = placed.current === null || placed.current === snap;
    placed.current = snap;
    if (still) el.style.transition = "none";
    el.style.transform = `translateY(${geo.offsets[snap]}px)`;
    el.style.setProperty("--fy-hide", `${geo.offsets[snap]}px`);
    if (still) {
      void el.offsetWidth;
      el.style.transition = "";
    }
  }, [snap, geo, narrow]);

  const grab = useRef(null);
  const live = useRef({});
  const sheetStart = () => {
    const el = sheetRef.current;
    grab.current = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
    el.dataset.drag = "";
  };
  const sheetMove = (dy) => {
    const g = geoRef.current;
    sheetRef.current.style.transform = `translateY(${resist(grab.current + dy, 0, g.offsets.peek)}px)`;
  };
  const sheetEnd = (dy, vy) => {
    const g = geoRef.current;
    const el = sheetRef.current;
    const from = Math.min(g.offsets.peek, Math.max(0, grab.current + dy));
    const to = pickSnap(from, vy, [g.offsets.full, g.offsets.half, g.offsets.peek]);
    delete el.dataset.drag;
    el.style.transform = `translateY(${to}px)`;
    el.style.setProperty("--fy-hide", `${to}px`);
    goSnap(snapName(to, g.offsets));
  };

  live.current = { sheetStart, sheetMove, sheetEnd };

  /* Desde la barra y las pestanas la hoja se arrastra siempre. */
  const topDrag = useDrag({
    axis: "y",
    onStart: sheetStart,
    onMove: ({ dy }) => sheetMove(dy),
    onEnd: ({ dy, vy }) => sheetEnd(dy, vy),
  });
  /* Desde la lista: raton y dedo con la hoja a medias (touch-action: none) por
     aqui; con la hoja completa el dedo es del scroll, y tirar hacia abajo
     desde arriba del todo lo recoge el efecto de touch de abajo. */
  const bodyDrag = useDrag({
    axis: "y",
    canStart: (e) => snapRef.current !== "full" || e.pointerType === "mouse",
    shouldStart: ({ dy }) =>
      listDrag({ scrollTop: listRef.current.scrollTop, dy, atFull: snapRef.current === "full" }) === "sheet",
    onStart: sheetStart,
    onMove: ({ dy }) => sheetMove(dy),
    onEnd: ({ dy, vy }) => sheetEnd(dy, vy),
  });

  useEffect(() => {
    const list = listRef.current;
    if (!narrow || !list) return undefined;
    let t = null;
    const sample = (y, ts) => {
      t.samples.push({ t: ts, x: 0, y });
      if (t.samples.length > 8) t.samples.shift();
    };
    const onStart = (e) => {
      t = snapRef.current === "full" && e.touches.length === 1 && list.scrollTop <= 0
        ? { y: e.touches[0].clientY, on: false, samples: [{ t: e.timeStamp, x: 0, y: e.touches[0].clientY }] }
        : null;
    };
    const onMove = (e) => {
      if (!t) return;
      const y = e.touches[0].clientY;
      const dy = y - t.y;
      sample(y, e.timeStamp);
      if (!t.on) {
        if (dy < -4 || list.scrollTop > 0) t = null;
        else if (dy > 8 && e.cancelable) {
          e.preventDefault();
          t.on = true;
          live.current.sheetStart();
        }
        return;
      }
      e.preventDefault();
      live.current.sheetMove(dy);
    };
    const onEnd = (e) => {
      if (!t?.on) {
        t = null;
        return;
      }
      const last = e.changedTouches[0];
      const dy = last.clientY - t.y;
      sample(last.clientY, e.timeStamp);
      const first = t.samples.filter((s) => e.timeStamp - s.t <= 90);
      const a = first[0];
      const b = first[first.length - 1];
      const vy = a && b && b.t > a.t ? ((b.y - a.y) / (b.t - a.t)) * 1000 : 0;
      t = null;
      live.current.sheetEnd(dy, vy);
    };
    list.addEventListener("touchstart", onStart, { passive: true });
    list.addEventListener("touchmove", onMove, { passive: false });
    list.addEventListener("touchend", onEnd, { passive: true });
    list.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      list.removeEventListener("touchstart", onStart);
      list.removeEventListener("touchmove", onMove);
      list.removeEventListener("touchend", onEnd);
      list.removeEventListener("touchcancel", onEnd);
    };
  }, [narrow]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSheet = () => goSnap(snap === "peek" ? "half" : "peek");
  const peekKey = (e) => {
    const order = ["peek", "half", "full"];
    const at = order.indexOf(snap);
    if (e.key === "ArrowUp" && at < 2) goSnap(order[at + 1]);
    else if (e.key === "ArrowDown" && at > 0) goSnap(order[at - 1]);
    else return;
    e.preventDefault();
  };

  /* --- Panel lateral (pantalla ancha) --------------------------------------- */

  /* Recoger o abrir con un gesto del teclado o del boton devuelve el foco al
     otro lado (el panel recogido es inerte y el foco se perderia). */
  const fold = (value, moveFocus = false) => {
    refocus.current = moveFocus;
    setCollapsed(value);
  };
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const target = collapsed ? pillRef.current : sideRef.current?.querySelector(".fy__fold");
    target?.focus({ preventScroll: true });
  }, [collapsed]);

  const sideDrag = useDrag({
    axis: "x",
    onStart: () => {
      sideRef.current.dataset.drag = "";
    },
    onMove: ({ dx }) => {
      sideRef.current.style.transform = `translateX(${resist(dx, 0, PANEL_ROOM, 0.2)}px)`;
    },
    onEnd: ({ dx, vx }) => {
      const el = sideRef.current;
      delete el.dataset.drag;
      el.style.transform = "";
      if (panelDecision(dx, PANEL_W, vx) === "collapse") fold(true);
    },
  });
  const tabDrag = useDrag({
    axis: "x",
    onEnd: ({ dx, vx }) => {
      if (tabDecision(dx, vx) === "expand") fold(false);
    },
  });

  /* --- Teclado: Escape cierra el menu y, si no, recoge la hoja -------------- */

  const onKeyDown = (e) => {
    if (e.key !== "Escape") return;
    if (menu) {
      const more = document.querySelector(".fy-more[aria-expanded='true']");
      setMenu(null);
      more?.focus({ preventScroll: true });
    } else if (narrow && snap !== "peek") {
      goSnap("peek");
      peekRef.current?.focus({ preventScroll: true });
    } else {
      return;
    }
    /* El mapa no debe cerrar tambien la tarjeta del genero. */
    e.stopPropagation();
  };

  /* --- Contenido ------------------------------------------------------------ */

  const tabs = (
    <div ref={segsRef} className="segs fy-tabs" role="group" aria-label="Contenido del panel">
      {[
        ["art", "Artistas"],
        ["gen", "Géneros"],
      ].map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={cx("seg", tab === id && "is-on")}
          aria-pressed={tab === id}
          onClick={() => {
            setTab(id);
            setMenu(null);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );

  const stateBlock = (k) => (
    <StateBlock kind={k} status={rec.status} onRestore={() => reco.restoreAll()} onRetry={() => reco.load(true)} />
  );

  const body = (
    <>
      {tab === "art" ? (
        rows.length === 0 ? (
          stateBlock(kind)
        ) : (
          <>
            {rec.status.offline && (
              <p className="fy-note">Sin conexión: se completará cuando vuelva.</p>
            )}
            <ul className="fy-list" aria-label="Artistas recomendados">
              {rows.map((row) => (
                <ArtistRow
                  key={row.name}
                  row={row}
                  data={data}
                  selected={sel?.name === row.name}
                  leaving={leaving.has(row.name)}
                  menuOpen={menu === row.name}
                  busy={busy === `a:${row.name}`}
                  listRef={listRef}
                  onSelect={() => select(row)}
                  onPlay={() => play(`a:${row.name}`, row.name, onPlayArtist)}
                  onToggleMenu={() => setMenu((m) => (m === row.name ? null : row.name))}
                  onMenuPick={(what) => menuPick(row, what)}
                  onHide={() => hide(row.name)}
                  onPreview={preview}
                />
              ))}
            </ul>
          </>
        )
      ) : mine.length === 0 && explore.length === 0 ? (
        stateBlock(kind === "hidden" ? "empty" : kind)
      ) : (
        <GenresTab
          data={data}
          mine={mine}
          explore={explore}
          busy={busy?.startsWith("g:") ? busy.slice(2) : null}
          onOpen={(i) => {
            setMenu(null);
            ctx.openGenre(i);
          }}
          onPlay={(name) => play(`g:${name}`, name, onPlayGenre)}
        />
      )}
      <p className="fy-foot">
        Calculado en tu dispositivo con MusicBrainz y ListenBrainz. Tu historial no sale de aquí.
      </p>
    </>
  );

  const title = <PanelTitle head={head} />;

  /* --- Hoja ------------------------------------------------------------------ */

  if (narrow) {
    const open = snap !== "peek";
    return (
      <section
        ref={sheetRef}
        className="fy fy--sheet"
        aria-label="Para ti"
        data-snap={snap}
        style={{ height: geo.full }}
        onKeyDown={onKeyDown}
      >
        <div className="fy__top" {...topDrag}>
          <button
            ref={peekRef}
            type="button"
            className="fy__peek"
            aria-expanded={open}
            aria-label={`${head}, ${open ? "recoger" : "desplegar"} el panel`}
            onClick={toggleSheet}
            onKeyDown={peekKey}
          >
            <span className="fy__grip" aria-hidden="true" />
            {title}
            <span className="fy__caret" aria-hidden="true">
              <Icon name="CaretDown" weight="fill" size={20} />
            </span>
          </button>
          <div inert={open ? undefined : ""}>{tabs}</div>
        </div>
        <div
          ref={listRef}
          className="fy__body"
          inert={open ? undefined : ""}
          {...bodyDrag}
        >
          {body}
        </div>
      </section>
    );
  }

  /* --- Panel lateral --------------------------------------------------------- */

  return (
    <>
      <section
        ref={sideRef}
        className={cx("fy fy--side", collapsed && "is-collapsed")}
        aria-label="Para ti"
        inert={collapsed ? "" : undefined}
        onKeyDown={onKeyDown}
      >
        <button
          type="button"
          className="fy__grab"
          tabIndex={-1}
          aria-label="Borde del panel Para ti: pulsa o arrastra a la derecha para replegarlo"
          title="Arrastra a la derecha para replegar"
          onClick={() => fold(true)}
          {...sideDrag}
        >
          <span aria-hidden="true" />
        </button>
        <div className="fy__head">
          {title}
          <button
            type="button"
            className="fy__fold"
            aria-label="Replegar el panel Para ti"
            onClick={() => fold(true, true)}
          >
            <Icon name="CaretDown" weight="fill" size={18} />
          </button>
        </div>
        {tabs}
        <div ref={listRef} className="fy__body">
          {body}
        </div>
      </section>
      {collapsed && (
        <button
          ref={pillRef}
          type="button"
          className="fy__pill"
          aria-label="Mostrar el panel Para ti"
          aria-expanded="false"
          onClick={() => fold(false, true)}
          {...tabDrag}
        >
          <Icon name="Sparkle" weight="fill" size={16} />
          <span>Para ti</span>
        </button>
      )}
    </>
  );
}
