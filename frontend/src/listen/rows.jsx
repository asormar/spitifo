import { memo } from "react";
import Ico from "../shared/ico.jsx";
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

/* Miniaturas que dieron error: una fila que se vuelve a montar (lista
   virtual) no reintenta un 404. */
const BAD_ART = new Set();

/* Sin `onMenu` la fila no lleva boton de opciones (la reusa Buscar); con el, lo
   abre y cierra ListenProvider (un menu en la pila de navegacion), asi que la
   fila no sabe si hay uno abierto y abrirlo no la repinta. `rank`
   pone el numero de puesto delante (los rankings), `sub` cambia la segunda
   linea (por defecto artista y album) y `badge` pone algo (una pastilla) antes
   de la duracion. `table` (escritorio) reparte la fila en celdas, alineadas con
   el encabezado de su tabla: puesto, titulo, album, duracion y menu; con
   "lib", titulo, artista, album, duracion y menu.

   Las paginas de un album, un artista o una lista llevan `num` (el numero de
   pista en vez de la portada; en la fila que suena, el ecualizador). `table`
   "trk" (# titulo duracion menu) y "lst" (asa # titulo duracion quitar menu).
   Las listas pasan ademas `drag` ({ transform, dragging, handleRef, handleProps },
   las del arrastre de useDragSort: esas filas no son memo, son pocas) y
   `onRemove(entry)`. `from` es el origen de la cola ("album:X", "library:"...):
   una cadena, para que la fila siga siendo memo. */
export const SongRow = memo(function SongRow({
  entry,
  list,
  enter,
  onPlay,
  onMenu,
  onRemove,
  rank,
  num,
  sub,
  badge,
  table,
  drag,
  from,
}) {
  const { key, title, artist, album } = entry;
  const isCurrent = useEngine((s) => s.track?.key === key);
  const playing = useEngine((s) => s.track?.key === key && s.playing);
  const video = entry.kind === "video";

  const lib = table === "lib";
  /* Tabla de pagina: sin portada ni album. */
  const page = table === "trk" || table === "lst";
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

  const numCell = num != null && (
    <span className="srow__n" aria-hidden="true">
      {isCurrent ? <Bars on={playing} /> : num}
    </span>
  );

  return (
    <div
      className={cx(
        "srow",
        table && "srow--t",
        lib && "srow--lib",
        page && `srow--${table}`,
        num != null && "srow--n",
        drag && "qrow",
        isCurrent && "is-current",
        drag?.dragging && "is-drag",
        enter != null && "is-in"
      )}
      style={enter != null || drag?.transform ? { "--i": enter, transform: drag?.transform } : undefined}
    >
      {drag && (
        <button
          type="button"
          ref={drag.handleRef}
          className="qrow__grip"
          data-no-swipe=""
          aria-label={`Mover ${title}. Usa las flechas para subir o bajar`}
          {...drag.handleProps}
        >
          <Ico n="grip" size={20} />
        </button>
      )}
      {table && (rankCell || numCell)}
      <button
        type="button"
        className="srow__main"
        aria-label={
          video
            ? `Abrir el vídeo ${title}`
            : `${playing ? "Pausar" : "Reproducir"} ${title}, ${artist}`
        }
        onClick={(e) => (isCurrent ? engine.toggle() : onPlay(entry, e.currentTarget, list, from))}
      >
        {!table && (rankCell || numCell)}
        {num == null && (
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
        )}
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
        {!table && num == null && dur && <span className="srow__d">{dur}</span>}
      </button>
      {lib && <span className="srow__c">{artist}</span>}
      {table && !page && <span className="srow__c">{album}</span>}
      {table && <span className="srow__c srow__d">{dur}</span>}
      {onRemove && (
        <button
          type="button"
          className="srow__more"
          aria-label={`Quitar ${title} de la lista`}
          title="Quitar de la lista"
          onClick={() => onRemove(entry)}
        >
          <Ico n="x" size={18} />
        </button>
      )}
      {!video && onMenu ? (
        <button
          type="button"
          className="srow__more"
          aria-label={`Más opciones de ${title}`}
          title="Más opciones"
          aria-haspopup="menu"
          onClick={(e) => onMenu(key, e.currentTarget)}
        >
          <Ico n="dots" size={20} />
        </button>
      ) : (
        table && <span />
      )}
    </div>
  );
});

/* Encabezado de una tabla de canciones: las mismas columnas que sus filas.
   `lib` (titulo, artista, album...) o, sin ella, la del ranking; `sticky` lo
   deja pegado bajo la barra de arriba. */
export const Thead = ({ lib, kind, sticky }) => (
  <div className={cx("thd", sticky && "thd--s", lib && "thd--lib", kind && `thd--${kind}`)} aria-hidden="true">
    {kind === "lst" && <span />}
    {kind ? <span className="ra">#</span> : !lib && <span />}
    <span>Título</span>
    {lib && <span>Artista</span>}
    {!kind && <span>Álbum</span>}
    <span className="ra">Duración</span>
    {kind === "lst" && <span />}
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
          <Ico n="grip" size={20} />
        </button>
      )}
      <button
        type="button"
        className="srow__main"
        aria-label={
          now
            ? `${playing ? "Pausar" : "Reproducir"} ${track.title}`
            : `Reproducir ahora ${track.title}`
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
