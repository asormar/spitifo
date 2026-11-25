import { memo } from "react";
import { cx } from "../shared/ui.jsx";
import { keyUrl } from "../shared/api.js";
import { clock } from "../shared/format.js";
import { coverTone, toneClass, toneVars } from "../shared/cover.js";
import { VerdictPill } from "../shared/Verdict.jsx";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { useOnline } from "../shared/online.js";
import { Icon } from "./icons.jsx";
import { checkOf, rowPill } from "./fileCheck.js";
import { rowArt } from "./library.js";
import { rowState } from "./offline.js";
import { useShow } from "./Notice.jsx";
import { useArtRecord } from "./art.js";
import { songTarget } from "./artLogic.js";
import { selection } from "../app/selection.js";
import { isPc } from "../shared/viewport.js";

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
   linea (por defecto artista y album). La pastilla de veredicto sale de la
   propia fila (`entry`, estable, asi sigue siendo memo): en el telefono solo
   cuando algo no esta bien y, con `all` (un booleano), siempre que haya registro.
   `table` (escritorio) reparte la fila en celdas, alineadas con el encabezado
   de su tabla: puesto, titulo, album, duracion y menu; con "lib", titulo,
   artista, album, verificacion, duracion y menu.

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
  all,
  table,
  drag,
  from,
}) {
  const { key, title, artist, album } = entry;
  selection.remember(entry);
  const pc = isPc();
  const online = useOnline();
  const show = useShow();
  const state = rowState(entry, online);
  /* Guardada sin archivo: la clave es el id. Guardada con archivo: la fila
     sigue teniendo la clave del archivo, pero suena con el id. Las dos
     coinciden en `sid`. */
  const mine = (t) => t?.key === key || Boolean(entry.sid && (t?.sid === entry.sid || t?.sid === key));
  const isCurrent = useEngine((s) => mine(s.track));
  const playing = useEngine((s) => mine(s.track) && s.playing);
  const video = entry.kind === "video";

  const lib = table === "lib";
  /* Tabla de pagina: sin portada ni album. */
  const page = table === "trk" || table === "lst";
  /* Las tablas de canciones llevan la columna Verificacion (siempre, con
     «Coincide»); fuera de ellas, la pastilla va antes de la duracion. */
  const checked = lib || page;
  const pill = checked || all ? checkOf(entry) : rowPill(entry);
  const meta = lib ? "" : sub ?? (album ? `${artist} · ${album}` : artist);
  const tone = coverTone(artist, album);
  const dur = entry.duration ? clock(Math.round(entry.duration)) : null;
  const artRec = useArtRecord(songTarget(entry));
  const src = rowArt(entry, keyUrl, true, artRec);
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

  /* Segundo punto de entrada del menu: clic derecho en la fila y Shift+F10 /
     tecla Menú sobre la fila enfocada. El botón ⋯ sigue ahí para descubrirlo. */
  const openRowMenu = (x, y, el) => {
    if (onMenu) onMenu(key, el, "menu", { point: { x, y } });
  };
  const onContext = (e) => {
    if (!onMenu) return;
    e.preventDefault();
    const el = e.currentTarget.querySelector(".srow__main") || e.currentTarget;
    openRowMenu(e.clientX, e.clientY, el);
  };
  const onRowKey = (e) => {
    if (!onMenu) return;
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      const el = e.currentTarget.querySelector(".srow__main") || e.currentTarget;
      const r = el.getBoundingClientRect();
      openRowMenu(r.left + 24, r.bottom, el);
    }
  };
  const siblingKeys = (el) =>
    [...el.parentElement.querySelectorAll("[data-song-key]")].map((n) => n.dataset.songKey);

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
        state.blocked && "is-locked",
        enter != null && "is-in"
      )}
      style={enter != null || drag?.transform ? { "--i": enter, transform: drag?.transform } : undefined}
      data-song-key={key}
      data-song-title={title}
      draggable={pc && !drag}
      onDragStart={(e) => {
        e.dataTransfer?.setData(
          "application/x-spitifo-song",
          JSON.stringify({ key, title, artist, album, sid: entry.sid, song: entry.song || null })
        );
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      }}
      onContextMenu={onContext}
      onKeyDown={onRowKey}
      onDoubleClick={() => {
        if (!isCurrent && !state.blocked) onPlay(entry, undefined, list, from);
      }}
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
          <Icon name="DotsSixVertical" size="md" />
        </button>
      )}
      {table && (rankCell || numCell)}
      <button
        type="button"
        className="srow__main"
        aria-label={
          state.blocked ? state.label
            : video
              ? `Abrir el vídeo ${title}`
              : `${playing ? "Pausar" : "Reproducir"} ${title}, ${artist}${entry.downloaded ? ", descargada" : ""}`
        }
        aria-disabled={state.blocked ? "true" : undefined}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            selection.toggle(entry);
            return;
          }
          if (e.shiftKey) {
            e.preventDefault();
            selection.rangeFromKeys(siblingKeys(e.currentTarget), entry.key);
            return;
          }
          /* El segundo clic de un doble clic no debe pausar lo que el primero
             acaba de poner a sonar. */
          if (e.detail > 1) return;
          selection.clear();
          if (state.blocked) {
            show?.(state.notice);
            return;
          }
          isCurrent ? engine.toggle() : onPlay(entry, e.currentTarget, list, from);
        }}
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
        {!table && pill && <VerdictPill v={pill} />}
        {!video && entry.downloaded && <span className={cx("srow__dl", table && "srow__dl--t")} aria-hidden="true" />}
        {!table && num == null && dur && <span className="srow__d">{dur}</span>}
      </button>
      {lib && <span className="srow__c">{artist}</span>}
      {table && !page && <span className="srow__c">{album}</span>}
      {checked && <span className="srow__v">{pill && <VerdictPill v={pill} />}</span>}
      {table && <span className="srow__c srow__d">{dur}</span>}
      {onRemove && (
        <button
          type="button"
          className="srow__more"
          aria-label={`Quitar ${title} de la lista`}
          title="Quitar de la lista"
          onClick={() => onRemove(entry)}
        >
          <Icon name="X" size="md" />
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
          <Icon name="DotsThree" size="md" />
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
    {(lib || kind) && <span>Verificación</span>}
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
          <Icon name="DotsSixVertical" size="md" />
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
          <Icon name="X" size="md" />
        </button>
      )}
    </div>
  );
}
