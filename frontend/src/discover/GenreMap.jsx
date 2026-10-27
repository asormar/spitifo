import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cx } from "../shared/ui.jsx";
import { placeCard, related, searchGenres } from "./map.js";
import { createMapCanvas } from "./mapCanvas.js";

/* Por debajo de este ancho la tarjeta pasa a hoja inferior. */
const NARROW = 560;
const NO_HIGHLIGHT = new Set();

/* Iconos sueltos: cada import de Phosphor trae sus seis pesos al chunk. */
const PATH = {
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  close: "M6 6l12 12M18 6L6 18",
  lupa: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.35-4.35",
  play: "M8 5.5v13l11-6.5z",
};

function Icon({ name, size = 18, className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATH[name]} />
    </svg>
  );
}

/* El mapa: lienzo + buscador + zoom + tarjeta del genero elegido.
   - `highlight`: Set de indices de genero a resaltar con un anillo ("Tus
     generos"). `focus` los marca con un anillo grueso (la fila elegida de "Para
     ti") y `preview` con uno suave (la fila bajo el puntero).
   - `onSearchGenre(nombre)`: lleva el genero a Descargar.
   - `onPlaySample(nombre)`: hace sonar una muestra; devuelve una promesa con
     cuantas pistas puso en la cola (0 = no habia previews).
   - `panel(ctx)`: pinta el panel "Para ti" dentro del mapa. Recibe el tamano
     del mapa, si es estrecho, si hay un genero abierto y las llamadas para
     volar a un genero, abrir/cerrar su tarjeta y avisar de cuanto tapa. */
export default function GenreMap({
  data,
  highlight = NO_HIGHLIGHT,
  focus = NO_HIGHLIGHT,
  preview = NO_HIGHLIGHT,
  onSearchGenre,
  onPlaySample,
  panel,
}) {
  const rootRef = useRef(null);
  const viewRef = useRef(null);
  const canvasRef = useRef(null);
  const cardRef = useRef(null);
  const inputRef = useRef(null);
  const engineRef = useRef(null);
  const pickRef = useRef(null);
  const mapSize = useRef({ w: 0, h: 0 });
  const cardSize = useRef({ w: 272, h: 220 });
  const narrowRef = useRef(false);
  /* Lo que tapa el panel por la derecha y por abajo; el lienzo y la tarjeta lo
     respetan. */
  const obstacleRef = useRef({ right: 0, bottom: 0 });
  /* Los anillos de "Para ti" tambien los lee el efecto que crea el lienzo. */
  const focusRef = useRef(focus);
  const previewRef = useRef(preview);
  focusRef.current = focus;
  previewRef.current = preview;

  const [sel, setSel] = useState(-1);
  const [narrow, setNarrow] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [obstacle, setObstacleState] = useState(obstacleRef.current);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /* Estado de la muestra del genero elegido: idle | loading | empty | error. */
  const [sample, setSample] = useState({ name: "", status: "idle" });
  const listId = useId();

  const results = useMemo(() => searchGenres(data, query, 8), [data, query]);

  /* La tarjeta sigue al punto con un transform que pone el lienzo en cada
     fotograma; en hoja inferior la fija el CSS. */
  const placeCardAt = useCallback((a) => {
    const el = cardRef.current;
    if (!el) return;
    if (!a || narrowRef.current) {
      el.style.transform = "";
      return;
    }
    /* La tarjeta nunca va bajo el panel: se coloca en el ancho que queda. */
    const room = { w: mapSize.current.w - obstacleRef.current.right, h: mapSize.current.h };
    const p = placeCard(a.x, a.y, cardSize.current, room, a.r);
    el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
  }, []);

  /* `how`: "fly" vuela al genero, "tap" solo lo sube si la hoja lo taparia. */
  const choose = useCallback((i, how) => {
    setSel(i);
    const engine = engineRef.current;
    if (!engine) return;
    engine.setSelected(i);
    if (i >= 0 && how === "fly") engine.flyTo(i);
    if (i >= 0 && how === "tap") engine.reveal(i);
  }, []);
  pickRef.current = (i) => choose(i, "tap");

  const setObstacle = useCallback((o) => {
    const next = { right: Math.max(0, o.right || 0), bottom: Math.max(0, o.bottom || 0) };
    const prev = obstacleRef.current;
    if (next.right === prev.right && next.bottom === prev.bottom) return;
    obstacleRef.current = next;
    setObstacleState(next);
    engineRef.current?.setObstacle(next);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const engine = createMapCanvas({
      canvas: canvasRef.current,
      host: root,
      data,
      onPick: (i) => pickRef.current(i),
      onAnchor: placeCardAt,
    });
    engineRef.current = engine;
    engine.setHighlight(highlight);
    engine.setFocusSet(focusRef.current);
    engine.setPreviewSet(previewRef.current);
    engine.setObstacle(obstacleRef.current);

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      /* Pantalla oculta (display:none): no hay nada que medir ni dibujar. */
      if (!width || !height) return;
      mapSize.current = { w: width, h: height };
      narrowRef.current = width < NARROW;
      engine.setNarrow(narrowRef.current);
      setNarrow(narrowRef.current);
      setBox((b) => (b.w === width && b.h === height ? b : { w: width, h: height }));
      engine.resize(width, height, Math.min(window.devicePixelRatio || 1, 2));
    });
    ro.observe(root);

    /* El tema vive en data-theme de <html>; la paleta y la tinta cambian con el. */
    const mo = new MutationObserver(() => engine.refreshTheme());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    let alive = true;
    document.fonts?.ready.then(() => alive && engine.refreshTheme());

    return () => {
      alive = false;
      ro.disconnect();
      mo.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
    // `highlight` se aplica en su propio efecto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, placeCardAt]);

  useEffect(() => {
    engineRef.current?.setHighlight(highlight);
  }, [highlight, data]);

  useEffect(() => {
    engineRef.current?.setFocusSet(focus);
  }, [focus, data]);
  useEffect(() => {
    engineRef.current?.setPreviewSet(preview);
  }, [preview, data]);

  /* La tarjeta se mide y se coloca antes de pintar: sin esto aparece un
     fotograma en la esquina. */
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el || sel < 0) return;
    cardSize.current = { w: el.offsetWidth, h: el.offsetHeight };
    placeCardAt(engineRef.current?.anchor(sel));
  }, [sel, narrow, obstacle, placeCardAt]);

  const name = sel >= 0 ? data.names[sel] : "";
  const rel = sel >= 0 ? Array.from(related(data, sel)) : [];
  /* El estado guardado es de otro genero: para este todavia no se pidio nada. */
  const sampleStatus = sample.name === name ? sample.status : "idle";

  const playSample = () => {
    if (!onPlaySample || sampleStatus === "loading") return;
    const asked = name;
    setSample({ name: asked, status: "loading" });
    Promise.resolve(onPlaySample(asked)).then(
      (count) => setSample((s) => (s.name === asked ? { name: asked, status: count > 0 ? "idle" : "empty" } : s)),
      () => setSample((s) => (s.name === asked ? { name: asked, status: "error" } : s))
    );
  };

  const goTo = (i) => {
    choose(i, "fly");
    setQuery("");
    setOpen(false);
    if (window.matchMedia("(pointer: coarse)").matches) inputRef.current?.blur();
  };

  const onSearchKey = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!results.length) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + step + results.length) % results.length);
    } else if (e.key === "Enter") {
      if (!results.length) return;
      e.preventDefault();
      goTo(results[Math.min(active, results.length - 1)]);
    } else if (e.key === "Escape" && (open || query)) {
      /* Primero cierra la lista; la tarjeta se queda. */
      e.stopPropagation();
      setQuery("");
      setOpen(false);
    }
  };

  const onRootKey = (e) => {
    if (e.key === "Escape" && sel >= 0) {
      choose(-1);
      viewRef.current?.focus({ preventScroll: true });
    }
  };

  const onViewKey = (e) => {
    if (engineRef.current?.key(e.nativeEvent)) e.preventDefault();
  };

  const showList = open && results.length > 0;

  return (
    <div
      className={cx("gmap", panel && narrow && "has-sheet")}
      data-no-swipe
      ref={rootRef}
      onKeyDown={onRootKey}
      style={obstacle.right ? { "--fy-right": `${obstacle.right}px` } : undefined}
    >
      {/* El foco del teclado vive aca: flechas mueven, +/- acercan, 0 encuadra. */}
      <div
        className="gmap__view"
        ref={viewRef}
        tabIndex={0}
        role="group"
        aria-label="Mapa de géneros"
        onKeyDown={onViewKey}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Mapa de ${data.count} géneros musicales. Los que están cerca comparten artistas; no es un mapa del sonido. Para ir a un género usa el buscador. Con el mapa enfocado, las flechas lo mueven, más y menos acercan o alejan y cero lo encuadra entero.`}
        />
      </div>

      <div className="gmap__search" role="search">
        <Icon name="lupa" className="gmap__lupa" />
        <input
          ref={inputRef}
          className="gmap__input"
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${active}` : undefined}
          aria-label="Buscar un género"
          placeholder="Buscar un género"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onSearchKey}
        />
        {showList && (
          <ul className="gmap__sugs" id={listId} role="listbox" aria-label="Géneros encontrados">
            {results.map((i, n) => (
              <li
                key={i}
                id={`${listId}-${n}`}
                className="gmap__sug"
                role="option"
                aria-selected={n === active}
                /* mousedown no debe quitarle el foco al input antes del click */
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => goTo(i)}
              >
                {data.names[i]}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="gmap__zoom" role="group" aria-label="Zoom del mapa">
        <button type="button" className="gmap__btn" aria-label="Acercar" onClick={() => engineRef.current?.zoomBy(1.6)}>
          <Icon name="plus" />
        </button>
        <button type="button" className="gmap__btn" aria-label="Alejar" onClick={() => engineRef.current?.zoomBy(1 / 1.6)}>
          <Icon name="minus" />
        </button>
        <button type="button" className="gmap__btn" aria-label="Ver todo el mapa" onClick={() => engineRef.current?.fit()}>
          <Icon name="fit" />
        </button>
      </div>

      {!(narrow && sel >= 0) && (
        <p className="gmap__note">Cerca = comparten artistas, no suenan parecido.</p>
      )}

      {sel >= 0 && (
        <div
          className={cx("gmap__card", narrow && "is-sheet")}
          ref={cardRef}
          role="region"
          aria-label={`Género: ${name}`}
        >
          <div className="gmap__cardin">
            <div className="gmap__head">
              <span className="gmap__dot" style={{ background: `var(--genre-${data.c[sel]})` }} aria-hidden="true" />
              <h2 className="gmap__name">{name}</h2>
              <button
                type="button"
                className="gmap__btn gmap__close"
                aria-label="Cerrar"
                onClick={() => {
                  choose(-1);
                  viewRef.current?.focus({ preventScroll: true });
                }}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            {rel.length > 0 && (
              <>
                <p className="gmap__sub" id={`${listId}-rel`}>
                  Géneros cercanos
                </p>
                <ul className="gmap__chips" aria-labelledby={`${listId}-rel`}>
                  {rel.map((j) => (
                    <li key={j}>
                      <button type="button" className="gmap__chip" onClick={() => choose(j, "fly")}>
                        <i style={{ background: `var(--genre-${data.c[j]})` }} aria-hidden="true" />
                        {data.names[j]}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="gmap__acts">
              {onPlaySample && (
                <button
                  type="button"
                  className="gmap__go gmap__sample"
                  onClick={playSample}
                  disabled={sampleStatus === "loading" || sampleStatus === "empty"}
                  aria-busy={sampleStatus === "loading"}
                >
                  <Icon name="play" size={16} />
                  {sampleStatus === "loading"
                    ? "Buscando…"
                    : sampleStatus === "empty"
                      ? "Sin muestras"
                      : sampleStatus === "error"
                        ? "Reintentar muestra"
                        : "Escuchar muestra"}
                </button>
              )}
              <button type="button" className="gmap__go gmap__go--quiet" onClick={() => onSearchGenre?.(name)}>
                Buscar en Descargar
              </button>
            </div>
          </div>
        </div>
      )}

      {panel?.({
        box,
        narrow,
        genreOpen: sel >= 0,
        setObstacle,
        flyTo: (i) => engineRef.current?.flyTo(i),
        openGenre: (i) => choose(i, "fly"),
        closeGenre: () => choose(-1),
      })}

      <p className="sr-only" aria-live="polite">
        {sel >= 0
          ? `${name}, seleccionado. ${rel.length} ${rel.length === 1 ? "género cercano" : "géneros cercanos"}.`
          : ""}
      </p>
    </div>
  );
}
