import { useLayoutEffect, useRef } from "react";
import { cx } from "../shared/ui.jsx";
import { hashHue } from "../player/tint.js";
import { swipeDecision, swipeOffset, swipeProgress } from "./gestures.js";
import { becauseText } from "./reco.js";
import { useDrag } from "./useDrag.js";

/* ---------------------------------------------------------------------------
   PIEZAS DE "PARA TI": filas de artistas, generos y los estados vacios

   Todo lo que va dentro del panel salvo el marco (hoja inferior o panel
   lateral) y los gestos del marco, que viven en ForYou.jsx.
   ------------------------------------------------------------------------- */

/* Iconos de 256 px (los de Phosphor que usa el diseno), sueltos para no traer
   los seis pesos de cada uno al chunk. */
export const PATH = {
  sparkle:
    "M208,144a15.78,15.78,0,0,1-10.42,14.94L146,178l-19,51.62a15.92,15.92,0,0,1-29.88,0L78,178l-51.62-19a15.92,15.92,0,0,1,0-29.88L78,110l19-51.62a15.92,15.92,0,0,1,29.88,0L146,110l51.62,19A15.78,15.78,0,0,1,208,144ZM152,48h16V64a8,8,0,0,0,16,0V48h16a8,8,0,0,0,0-16H184V16a8,8,0,0,0-16,0V32H152a8,8,0,0,0,0,16Zm88,32h-8V72a8,8,0,0,0-16,0v8h-8a8,8,0,0,0,0,16h8v8a8,8,0,0,0,16,0V96h8a8,8,0,0,0,0-16Z",
  caret: "M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z",
  dots: "M144,128a16,16,0,1,1-16-16A16,16,0,0,1,144,128ZM60,112a16,16,0,1,0,16,16A16,16,0,0,0,60,112Zm136,0a16,16,0,1,0,16,16A16,16,0,0,0,196,112Z",
  play: "M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z",
};

export function Ico({ name, size = 18, className }) {
  return (
    <svg className={className} viewBox="0 0 256 256" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d={PATH[name]} />
    </svg>
  );
}

/* "Ana Maria" -> "AM"; "Wisin & Yandel" -> "WY"; un solo nombre, sus dos primeras letras. */
export function initials(name) {
  const words = String(name || "")
    .replace(/&/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const text = words.length > 1 ? [...words[0]][0] + [...words[1]][0] : [...(words[0] || "?")].slice(0, 2).join("");
  return text.toUpperCase();
}

const genreColor = (data, i) => (i >= 0 ? `var(--genre-${data.c[i]})` : "var(--icon-dim)");

/* --- Estados ---------------------------------------------------------------- */

/* Lo que se ve cuando no hay filas de artistas (o de generos). */
export function StateBlock({ kind, status, onRestore, onRetry }) {
  if (kind === "warm") {
    const { done, total } = status;
    return (
      <div className="fy-card">
        <div className="fy-card__row">
          <p className="fy-card__t">Conociendo tus artistas…</p>
          {total > 0 && (
            <span className="fy-card__n">
              {done} de {total}
            </span>
          )}
        </div>
        <div
          className="fy-bar"
          role="progressbar"
          aria-label="Conociendo tus artistas"
          aria-valuemin={0}
          aria-valuemax={Math.max(total, 1)}
          aria-valuenow={Math.min(done, Math.max(total, 1))}
        >
          <div className="fy-bar__fill" style={{ transform: `scaleX(${total > 0 ? Math.min(1, done / total) : 0})` }} />
        </div>
        <p className="fy-card__p">Mientras tanto, prueba el mapa.</p>
      </div>
    );
  }
  if (kind === "loading") {
    return (
      <div className="fy-card" role="status">
        <p className="fy-card__p fy-card__p--first">Cargando recomendaciones…</p>
      </div>
    );
  }
  const copy = {
    offline: "Sin conexión: se completará cuando vuelva.",
    empty: "Descarga algo de música para recibir recomendaciones.",
    hidden: "Has ocultado todos los artistas.",
    error: "No se pudieron cargar las recomendaciones.",
  }[kind];
  const action = kind === "hidden" ? ["Mostrar de nuevo", onRestore] : kind === "error" ? ["Reintentar", onRetry] : null;
  return (
    <div className="fy-card fy-card--c">
      <p className="fy-card__t fy-card__t--s">{copy}</p>
      {action && (
        <button type="button" className="fy-ghost" onClick={action[1]}>
          {action[0]}
        </button>
      )}
    </div>
  );
}

/* --- Artistas --------------------------------------------------------------- */

const MENU_ITEMS = [
  ["search", "Buscar en Descargar"],
  ["hide", "No me interesa"],
];

/* Menu de la fila: flechas para moverse, abre hacia arriba si abajo no cabe. */
function RowMenu({ onPick, listRef }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    el.querySelector("button").focus({ preventScroll: true });
    const edge = (listRef.current || document.documentElement).getBoundingClientRect().bottom;
    if (el.getBoundingClientRect().bottom > edge) el.dataset.up = "";
  }, [listRef]);

  const onKeyDown = (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...ref.current.querySelectorAll("button")];
    const at = items.indexOf(document.activeElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  };

  return (
    <div ref={ref} className="fy-menu" role="menu" onKeyDown={onKeyDown}>
      {MENU_ITEMS.map(([kind, text]) => (
        <button key={kind} type="button" role="menuitem" onClick={() => onPick(kind)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/* Una fila. Deslizar a la izquierda (dedo o raton) la descarta; los botones
   siguen siendo botones. Si el arrastre es vertical se abandona y la lista se
   desplaza (touch-action: pan-y en el CSS). */
export function ArtistRow({
  row,
  data,
  selected,
  leaving,
  menuOpen,
  busy,
  listRef,
  onSelect,
  onPlay,
  onToggleMenu,
  onMenuPick,
  onHide,
  onPreview,
}) {
  const rowRef = useRef(null);
  const innerRef = useRef(null);
  const width = useRef(0);
  const drag = useDrag({
    axis: "x",
    onStart: () => {
      width.current = innerRef.current.offsetWidth;
      rowRef.current.dataset.swipe = "";
      if (menuOpen) onToggleMenu();
    },
    onMove: ({ dx }) => {
      innerRef.current.style.transform = `translateX(${swipeOffset(dx, width.current)}px)`;
      rowRef.current.style.setProperty("--sw", swipeProgress(dx, width.current).toFixed(3));
    },
    onEnd: ({ dx, vx, cancelled }) => {
      delete rowRef.current.dataset.swipe;
      rowRef.current.style.removeProperty("--sw");
      /* Sin estilo propio, manda la clase: vuelve a su sitio o sigue de largo. */
      innerRef.current.style.transform = "";
      if (!cancelled && swipeDecision(dx, width.current, vx) === "dismiss") onHide();
    },
  });

  const onKeyDown = (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && !e.target.closest(".fy-menu")) {
      e.preventDefault();
      onHide();
    }
  };

  const hue = hashHue(row.name);
  const why = becauseText(row.because) || row.genres.slice(0, 2).join(" · ");
  /* `gidx` va alineado con `genres`: -1 = ese genero no esta en el mapa. */
  const chips = row.genres.slice(0, 2).map((name, n) => ({ name, i: row.gidx[n] }));
  return (
    <li
      ref={rowRef}
      className={cx("fy-row", leaving && "is-leaving")}
      onKeyDown={onKeyDown}
      onPointerEnter={(e) => e.pointerType === "mouse" && onPreview(row)}
      onPointerLeave={(e) => e.pointerType === "mouse" && onPreview(null)}
    >
      <div className="fy-row__clip">
        <div className="fy-row__hide" aria-hidden="true">
          No me interesa
        </div>
        <div ref={innerRef} className={cx("fy-row__in", selected && "is-sel")} {...drag}>
          <button
            type="button"
            className="fy-row__main"
            aria-pressed={selected}
            aria-label={
              selected
                ? `Quitar el resaltado de ${row.name}`
                : `Resaltar en el mapa los géneros de ${row.name}`
            }
            onClick={onSelect}
          >
            <span className="fy-av" style={{ "--h": hue }} aria-hidden="true">
              {initials(row.name)}
            </span>
            <span className="fy-row__txt">
              <span className="fy-row__name">{row.name}</span>
              {why && <span className="fy-row__why">{why}</span>}
              {selected && chips.length > 0 && (
                <span className="fy-chips">
                  {chips.map((c) => (
                    <span key={c.name} className="fy-chip">
                      <i style={{ background: genreColor(data, c.i) }} aria-hidden="true" />
                      {c.name}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </button>
          <button
            type="button"
            className={cx("fy-btn fy-btn--play", busy && "is-busy")}
            aria-label={`Escuchar muestra de ${row.name}`}
            aria-busy={busy}
            onClick={onPlay}
          >
            <Ico name="play" />
          </button>
          <button
            type="button"
            className="fy-btn fy-btn--more fy-more"
            aria-label={`Más acciones: ${row.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={onToggleMenu}
          >
            <Ico name="dots" size={20} />
          </button>
          {menuOpen && <RowMenu onPick={onMenuPick} listRef={listRef} />}
        </div>
      </div>
    </li>
  );
}

/* --- Generos ---------------------------------------------------------------- */

const percent = (share) => {
  const n = Math.round(share * 100);
  return n < 1 ? "<1 %" : `${n} %`;
};

/* "Tus generos" (con su barra) y "Para explorar" (vecinos que aun no son tuyos). */
export function GenresTab({ data, mine, explore, busy, onOpen, onPlay }) {
  const top = mine.length ? mine[0].share : 1;
  return (
    <>
      {mine.length > 0 && (
        <>
          <h3 className="fy-h">Tus géneros</h3>
          <ol className="fy-list">
            {mine.map((g, n) => {
              const body = (
                <>
                  <span className="fy-gen__rank" aria-hidden="true">
                    {n + 1}
                  </span>
                  <span className="fy-gen__body">
                    <span className="fy-gen__top">
                      <span className="fy-gen__name">
                        <i style={{ background: genreColor(data, g.i) }} aria-hidden="true" />
                        <span>{g.name}</span>
                      </span>
                      <span className="fy-gen__pct">{percent(g.share)}</span>
                    </span>
                    <span className="fy-gen__bar" aria-hidden="true">
                      <span style={{ width: `${Math.round((g.share / top) * 100)}%`, background: genreColor(data, g.i) }} />
                    </span>
                  </span>
                </>
              );
              return (
                <li key={g.name}>
                  {g.i >= 0 ? (
                    <button
                      type="button"
                      className="fy-gen"
                      aria-label={`${g.name}, ${percent(g.share)}. Ver en el mapa`}
                      onClick={() => onOpen(g.i)}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="fy-gen fy-gen--off">{body}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
      {explore.length > 0 && (
        <>
          <h3 className="fy-h fy-h--gap">Para explorar</h3>
          <ul className="fy-list">
            {explore.map(({ i, near }) => {
              const name = data.names[i];
              return (
                <li key={i} className="fy-exp">
                  <button
                    type="button"
                    className="fy-exp__main"
                    aria-label={`${name}, cerca de ${data.names[near]}. Ver en el mapa`}
                    onClick={() => onOpen(i)}
                  >
                    <i style={{ background: genreColor(data, i) }} aria-hidden="true" />
                    <span className="fy-row__txt">
                      <span className="fy-row__name">{name}</span>
                      <span className="fy-exp__near">cerca de {data.names[near]}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={cx("fy-btn fy-btn--play", busy === name && "is-busy")}
                    aria-label={`Escuchar muestra de ${name}`}
                    aria-busy={busy === name}
                    onClick={() => onPlay(name)}
                  >
                    <Ico name="play" />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
