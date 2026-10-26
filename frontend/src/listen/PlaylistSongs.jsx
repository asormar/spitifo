import { cx } from "../shared/ui.jsx";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import VirtualList from "./VirtualList.jsx";
import { Bars, initial } from "./rows.jsx";
import { Icon } from "./icons.jsx";
import { playlists, visibleToKeyIndex } from "./playlists.js";
import { useDragSort } from "./useDragSort.js";

/* ---------------------------------------------------------------------------
   CANCIONES DE UNA LISTA

   Las canciones de la lista que siguen en la biblioteca, en el orden de la
   lista. Las claves que ya no estan en la biblioteca se conservan en los datos
   pero no se ven, asi que la posicion de una fila NO es su posicion en
   `playlist.keys`: al soltar se traduce cada extremo a la clave que ocupa y se
   mueve por clave (visibleToKeyIndex).
   ------------------------------------------------------------------------- */

function PlaylistSongRow({ entry, enter, transform, dragging, handleRef, handleProps, onPlay, onRemove }) {
  const { key, title, artist, album } = entry;
  const isCurrent = useEngine((s) => s.track?.key === key);
  const playing = useEngine((s) => s.track?.key === key && s.playing);

  return (
    <div
      className={cx("srow qrow", isCurrent && "is-current", dragging && "is-drag", enter != null && "is-in")}
      style={{ "--i": enter, transform }}
    >
      <button
        type="button"
        ref={handleRef}
        className="qrow__grip"
        data-no-swipe=""
        aria-label={`Mover ${title}. Usa las flechas para subir o bajar`}
        {...handleProps}
      >
        <Icon name="grip" size={20} />
      </button>
      <button
        type="button"
        className="srow__main"
        aria-label={`${playing ? "Pausar" : "Reproducir"} ${title}, ${artist}`}
        onClick={(e) => (isCurrent ? engine.toggle() : onPlay(entry, e.currentTarget))}
      >
        <span className="art">{isCurrent ? <Bars on={playing} /> : initial(artist)}</span>
        <span className="srow__txt">
          <span className="srow__t">{title}</span>
          <span className="srow__m">{album ? `${artist} · ${album}` : artist}</span>
        </span>
      </button>
      <button
        type="button"
        className="srow__more"
        aria-label={`Quitar ${title} de la lista`}
        title="Quitar de la lista"
        onClick={onRemove}
      >
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}

export default function PlaylistSongs({ playlist, rows, active, onPlay }) {
  const keys = rows.map((e) => e.key);

  const move = (from, to) => {
    if (to < 0 || to >= rows.length) return false;
    const [a, b] = visibleToKeyIndex(playlist.keys, keys, from, to);
    return playlists.move(playlist.id, a, b);
  };
  const sort = useDragSort({ first: 0, last: rows.length - 1, onMove: move, watch: rows });

  return (
    <VirtualList
      active={active}
      count={rows.length}
      className={sort.dragging ? "is-sorting" : undefined}
      getKey={(i) => rows[i].key}
      renderRow={(i, enter) => (
        <PlaylistSongRow
          entry={rows[i]}
          enter={enter}
          transform={sort.transformFor(i)}
          dragging={sort.isDragged(i)}
          handleRef={sort.handleRef(rows[i].key)}
          handleProps={sort.handlePropsFor(rows[i].key, i)}
          onPlay={(entry, el) => onPlay(entry, el, rows)}
          onRemove={() => playlists.removeKey(playlist.id, rows[i].key)}
        />
      )}
    />
  );
}
