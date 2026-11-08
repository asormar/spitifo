import { memo, useLayoutEffect, useRef } from "react";
import { cx } from "../shared/ui.jsx";
import { keyUrl } from "../shared/api.js";
import { clock } from "../shared/format.js";
import { coverTone, toneClass, toneVars } from "../shared/cover.js";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { Icon } from "./icons.jsx";
import { rowArt } from "./library.js";

/* ---------------------------------------------------------------------------
   FILAS DE ESCUCHAR

   Las filas son vistas del motor, igual que el mini-reproductor: preguntan
   "soy la actual?" y "estoy sonando?" (booleanos, ver useEngine.js) y nunca
   leen la foto entera, porque con la lista montada el motor emite cuatro veces
   por segundo.
   ------------------------------------------------------------------------- */

/* No hay portada por pista en la biblioteca: la inicial hace de portada. */
export const initial = (name) => ([...String(name || "").trim()][0] || "?").toUpperCase();

/* Ecualizador de la fila actual: quieto mientras no suena (ver listen.css). */
export const Bars = ({ on }) => (
  <span className="eq" aria-hidden="true" data-on={on ? "" : undefined}>
    <i />
    <i />
    <i />
  </span>
);

/* Menu de la fila. Lo abre y lo cierra ListenProvider (solo hay uno a la vez); aqui
   solo se coloca y se maneja con flechas. `items`: [clave, texto]; la clave es
   lo que recibe `onPick`. */
export function RowMenu({ items, onPick }) {
  const ref = useRef(null);

  useLayoutEffect(() => {
    const el = ref.current;
    el.querySelector("button").focus({ preventScroll: true });
    /* Sin sitio debajo (fin de pagina, barra inferior) se abre hacia arriba. */
    if (el.getBoundingClientRect().bottom > window.innerHeight - 120) el.dataset.up = "";
  }, []);

  const onKeyDown = (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...ref.current.querySelectorAll("button")];
    const at = items.indexOf(document.activeElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  };

  return (
    <div ref={ref} className="rmenu" role="menu" onKeyDown={onKeyDown}>
      {items.map(([kind, text]) => (
        <button key={kind} type="button" role="menuitem" onClick={() => onPick(kind)}>
          {text}
        </button>
      ))}
    </div>
  );
}

const SONG_ITEMS = [
  ["next", "Reproducir a continuación"],
  ["end", "Añadir a la cola"],
  ["list", "Añadir a una lista…"],
];

/* Miniaturas que dieron error: una fila que se vuelve a montar (lista
   virtual) no reintenta un 404. */
const BAD_ART = new Set();

/* Sin `onMenu` la fila no lleva boton de opciones (la reusa Buscar). `rank`
   pone el numero de puesto delante (los rankings), `sub` cambia la segunda
   linea (por defecto artista y album) y `badge` pone algo (una pastilla) antes
   de la duracion. `table` (escritorio) reparte la fila en celdas, alineadas con
   el encabezado de su tabla: puesto, titulo, album, duracion y menu; con
   "lib", titulo, artista, album, duracion y menu. */
export const SongRow = memo(function SongRow({ entry, list, enter, menuOpen, onPlay, onMenu, onPick, rank, sub, badge, table }) {
  const { key, title, artist, album } = entry;
  const isCurrent = useEngine((s) => s.track?.key === key);
  const playing = useEngine((s) => s.track?.key === key && s.playing);
  const video = entry.kind === "video";

  const lib = table === "lib";
  const meta = lib ? "" : sub ?? (album ? `${artist} · ${album}` : artist);
  const tone = coverTone(artist, album);
  const dur = entry.duration ? clock(Math.round(entry.duration)) : null;
  const src = rowArt(entry, keyUrl);
  const img = src && !BAD_ART.has(src);
  const rankCell = rank != null && (
    <span className={cx("srow__rank", rank <= 3 && "is-top")} aria-hidden="true">
      {rank}
    </span>
  );

  return (
    <div
      className={cx("srow", table && "srow--t", lib && "srow--lib", isCurrent && "is-current", enter != null && "is-in")}
      style={enter != null ? { "--i": enter } : undefined}
    >
      {table && rankCell}
      <button
        type="button"
        className="srow__main"
        aria-label={
          video
            ? `Abrir el vídeo ${title}`
            : `${playing ? "Pausar" : "Reproducir"} ${title}, ${artist}`
        }
        onClick={(e) => (isCurrent ? engine.toggle() : onPlay(entry, e.currentTarget, list))}
      >
        {!table && rankCell}
        <span className={cx("art", toneClass(tone))} style={toneVars(tone)}>
          {isCurrent && !img ? <Bars on={playing} /> : initial(artist)}
          {img && (
            <img
              className="art__img"
              src={src}
              alt=""
              width="48"
              height="48"
              loading="lazy"
              decoding="async"
              fetchpriority="low"
              onError={(e) => {
                BAD_ART.add(src);
                e.currentTarget.hidden = true;
              }}
            />
          )}
          {isCurrent && img && (
            <span className="cv__now">
              <Bars on={playing} />
            </span>
          )}
        </span>
        <span className="srow__txt">
          <span className="srow__t">{title}</span>
          {(video || meta) && (
            <span className="srow__m">
              {video && <span className="tag">{entry.hasAudio ? "Vídeo" : "Vídeo sin audio"}</span>}
              {meta}
            </span>
          )}
        </span>
        {!table && badge}
        {!table && dur && <span className="srow__d">{dur}</span>}
      </button>
      {lib && <span className="srow__c">{artist}</span>}
      {table && <span className="srow__c">{album}</span>}
      {table && <span className="srow__c srow__d">{dur}</span>}
      {!video && onMenu ? (
        <button
          type="button"
          className="srow__more"
          aria-label={`Más opciones de ${title}`}
          title="Más opciones"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => onMenu(key, e.currentTarget)}
        >
          <Icon name="DotsThree" weight="bold" size={22} />
        </button>
      ) : (
        table && <span />
      )}
      {menuOpen && <RowMenu items={SONG_ITEMS} onPick={(kind) => onPick(entry, kind)} />}
    </div>
  );
});

/* Encabezado de una tabla de canciones: las mismas columnas que sus filas.
   `lib` (titulo, artista, album...) o, sin ella, la del ranking; `sticky` lo
   deja pegado bajo la barra de arriba. */
export const Thead = ({ lib, sticky }) => (
  <div className={cx("thd", sticky && "thd--s", lib && "thd--lib")} aria-hidden="true">
    {!lib && <span />}
    <span>Título</span>
    {lib && <span>Artista</span>}
    <span>Álbum</span>
    <span className="ra">Duración</span>
    <span />
  </div>
);

/* Fila de la cola. `now` = la que suena (sin asa ni quitar). `pos` es su
   posicion en la cola del motor, no en la lista visible. `transform` lo pone
   QueueList mientras se arrastra. */
export function QueueRow({
  track,
  pos,
  now,
  enter,
  transform,
  dragging,
  handleRef,
  handleProps,
}) {
  const playing = useEngine((s) => now && s.playing);
  const qtone = coverTone(track.meta || track.title);

  return (
    <div
      className={cx(
        "srow qrow",
        now && "is-current",
        dragging && "is-drag",
        enter != null && "is-in"
      )}
      style={{ "--i": enter, transform }}
    >
      {!now && (
        <button
          type="button"
          ref={handleRef}
          className="qrow__grip"
          data-no-swipe=""
          aria-label={`Mover ${track.title}. Usa las flechas para subir o bajar`}
          {...handleProps}
        >
          <Icon name="DotsSixVertical" size={20} />
        </button>
      )}
      <button
        type="button"
        className="srow__main"
        aria-label={
          now
            ? `${playing ? "Pausar" : "Reproducir"} ${track.title}`
            : `Reproducir ${track.title}`
        }
        onClick={() => (now ? engine.toggle() : engine.playAt(pos))}
      >
        <span className={cx("art", toneClass(qtone))} style={toneVars(qtone)}>
          {now ? <Bars on={playing} /> : initial(track.meta || track.title)}
        </span>
        <span className="srow__txt">
          <span className="srow__t">{track.title}</span>
          <span className="srow__m">{track.meta}</span>
        </span>
      </button>
      {!now && (
        <button
          type="button"
          className="srow__more"
          aria-label={`Quitar ${track.title} de la cola`}
          title="Quitar de la cola"
          onClick={() => engine.removeAt(pos)}
        >
          <Icon name="X" size={18} />
        </button>
      )}
    </div>
  );
}
