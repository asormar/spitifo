import VirtualList from "./VirtualList.jsx";
import { playlists, visibleToKeyIndex } from "./playlists.js";
import { useDragSort } from "./useDragSort.js";

/* ---------------------------------------------------------------------------
   CANCIONES DE UNA LISTA

   Las canciones de la lista que siguen en la biblioteca, en el orden de la
   lista. Las claves que ya no estan en la biblioteca se conservan en los datos
   pero no se ven, asi que la posicion de una fila NO es su posicion en
   `playlist.keys`: al soltar se traduce cada extremo a la clave que ocupa y se
   mueve por clave (visibleToKeyIndex). Las filas son las de ctx.song con el
   asa, el numero y "quitar" (rows.jsx).
   ------------------------------------------------------------------------- */

export default function PlaylistSongs({ playlist, rows, active, ctx, table, onRemove }) {
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
      dragged={sort.isDragged}
      renderRow={(i, enter) =>
        ctx.song(rows[i], rows, {
          enter,
          num: i + 1,
          table,
          onRemove,
          drag: {
            transform: sort.transformFor(i),
            dragging: sort.isDragged(i),
            handleRef: sort.handleRef(rows[i].key),
            handleProps: sort.handlePropsFor(rows[i].key, i),
          },
        })
      }
    />
  );
}
