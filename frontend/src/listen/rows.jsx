import { useEffect, useLayoutEffect, useRef } from "react";
import { X } from "@phosphor-icons/react";
import { cx } from "../shared/ui.jsx";
import { clock } from "../shared/format.js";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import { Icon } from "./icons.jsx";

/* ---------------------------------------------------------------------------
   FILAS DE ESCUCHAR

   Las filas son vistas del motor, igual que el mini-reproductor: preguntan
   "soy la actual?" y "estoy sonando?" (booleanos, ver useEngine.js) y nunca
   leen la foto entera, porque con la lista montada el motor emite cuatro veces
   por segundo. Cada fila registra su caja en el motor para que el
   mini-reproductor sepa si la cancion que suena esta a la vista.
   ------------------------------------------------------------------------- */

/* No hay portada por pista en la biblioteca: la inicial hace de portada. */
export const initial = (name) => ([...String(name || "").trim()][0] || "?").toUpperCase();

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* Ecualizador de la fila actual: quieto mientras no suena (ver listen.css). */
const Bars = ({ on }) => (
  <span className="eq" aria-hidden="true" data-on={on ? "" : undefined}>
    <i />
    <i />
    <i />
  </span>
);

/* Registra la caja de una fila para el mini-reproductor. */
function useRegisterRow(key, ref, enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    return engine.registerElement(key, ref.current);
  }, [key, ref, enabled]);
}

/* Menu de la fila. Lo abre y lo cierra ListenView (solo hay uno a la vez); aqui
   solo se coloca y se maneja con flechas. */
function RowMenu({ onPick }) {
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
      <button type="button" role="menuitem" onClick={() => onPick("next")}>
        Reproducir a continuación
      </button>
      <button type="button" role="menuitem" onClick={() => onPick("end")}>
        Añadir a la cola
      </button>
    </div>
  );
}

/* Sin `onMenu` la fila no lleva boton de opciones (la reusa Descargar). */
export function SongRow({ entry, enter, menuOpen, onPlay, onMenu, onPick }) {
  const { key, title, artist, album } = entry;
  const rootRef = useRef(null);
  const isCurrent = useEngine((s) => s.track?.key === key);
  const playing = useEngine((s) => s.track?.key === key && s.playing);
  const video = entry.kind === "video";
  useRegisterRow(key, rootRef);

  const meta = album ? `${artist} · ${album}` : artist;
  const dur = entry.duration ? clock(Math.round(entry.duration)) : null;

  return (
    <div
      ref={rootRef}
      className={cx("srow", isCurrent && "is-current", enter != null && "is-in")}
      style={enter != null ? { "--i": enter } : undefined}
    >
      <button
        type="button"
        className="srow__main"
        aria-label={
          video
            ? `Abrir el vídeo ${title}`
            : `${playing ? "Pausar" : "Reproducir"} ${title}, ${artist}`
        }
        onClick={(e) => (isCurrent ? engine.toggle() : onPlay(entry, e.currentTarget))}
      >
        <span className="art">{isCurrent ? <Bars on={playing} /> : initial(artist)}</span>
        <span className="srow__txt">
          <span className="srow__t">{title}</span>
          <span className="srow__m">
            {video && <span className="tag">{entry.hasAudio ? "Vídeo" : "Vídeo sin audio"}</span>}
            {meta}
          </span>
        </span>
        {dur && <span className="srow__d">{dur}</span>}
      </button>
      {!video && onMenu && (
        <button
          type="button"
          className="srow__more"
          aria-label={`Más opciones de ${title}`}
          title="Más opciones"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => onMenu(key, e.currentTarget)}
        >
          <Icon name="more" size={22} />
        </button>
      )}
      {menuOpen && <RowMenu onPick={(kind) => onPick(entry, kind)} />}
    </div>
  );
}

/* Artista (circulo) o album (cuadrado). `group.artist` solo existe en albumes. */
export function GroupRow({ group, album, enter, onOpen }) {
  const songs = plural(group.entries.length, "canción", "canciones");
  const meta = album
    ? `${group.artist} · ${songs}`
    : group.albumCount > 0
      ? `${songs} · ${plural(group.albumCount, "álbum", "álbumes")}`
      : songs;

  return (
    <div
      className={cx("srow", enter != null && "is-in")}
      style={enter != null ? { "--i": enter } : undefined}
    >
      <button
        type="button"
        className="srow__main"
        aria-label={`${group.name}, ${meta}`}
        onClick={() => onOpen(group)}
      >
        <span className={cx("art", !album && "art--round")}>{initial(group.name)}</span>
        <span className="srow__txt">
          <span className="srow__t">{group.name}</span>
          <span className="srow__m">{meta}</span>
        </span>
        <Icon name="next" className="srow__go" />
      </button>
    </div>
  );
}

/* Fila de la cola. `now` = la que suena (sin asa ni quitar). `pos` es su
   posicion en la cola del motor, no en la lista visible. `transform` lo pone
   QueueList mientras se arrastra. `reg` = false la deja fuera del registro del
   mini-reproductor: la cola de "Ahora suena" no es la fila de la biblioteca. */
export function QueueRow({
  track,
  pos,
  now,
  reg = true,
  enter,
  transform,
  dragging,
  handleRef,
  handleProps,
}) {
  const rootRef = useRef(null);
  const playing = useEngine((s) => now && s.playing);
  /* Solo la que suena puede ser "la fila a la vista" de su pista. */
  useRegisterRow(track.key, rootRef, now && reg);

  return (
    <div
      ref={rootRef}
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
          <Icon name="grip" size={20} />
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
        <span className="art">{now ? <Bars on={playing} /> : initial(track.meta || track.title)}</span>
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
          <X size={18} />
        </button>
      )}
    </div>
  );
}
