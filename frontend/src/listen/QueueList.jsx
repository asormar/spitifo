import { useMemo } from "react";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import VirtualList from "./VirtualList.jsx";
import { QueueRow } from "./rows.jsx";
import { useDragSort } from "./useDragSort.js";

/* ---------------------------------------------------------------------------
   COLA

   Lo que suena arriba y, debajo, lo que falta por sonar en una lista virtual.
   Se pide al motor la cola y el indice por separado: `state.queue` es el mismo
   arreglo hasta que la cola cambia, asi que el timeupdate (cuatro veces por
   segundo) no repinta nada aqui.

   REORDENAR. El arrastre y las flechas viven en useDragSort, compartido con las
   listas de reproduccion. El motor solo se toca al soltar (engine.move una
   vez): mientras se arrastra la cola real no cambia, asi que cancelar es
   soltar y ya. En "Ahora suena" la lista scrollea en su propio contenedor, que
   llega como `scroller` (una ref).
   ------------------------------------------------------------------------- */

export default function QueueList({ active, scroller }) {
  const queue = useEngine((s) => s.queue);
  const index = useEngine((s) => s.index);
  const track = useEngine((s) => s.track);
  const repeat = useEngine((s) => s.repeat);

  const upcoming = useMemo(() => (index >= 0 ? queue.slice(index + 1) : []), [queue, index]);
  const first = index + 1;

  /* Posiciones de la cola del motor, no de la lista visible. */
  const sort = useDragSort({
    scroller,
    first,
    last: queue.length - 1,
    onMove: engine.move,
    watch: queue,
  });

  if (!track) {
    return <p className="lnote">La cola está vacía. Toca una canción para empezar.</p>;
  }

  return (
    <>
      <h2 className="llabel">Sonando</h2>
      <div className="qnow">
        <QueueRow track={track} pos={index} now reg={!scroller} />
      </div>
      <h2 className="llabel">A continuación</h2>
      {upcoming.length ? (
        <VirtualList
          active={active}
          scroller={scroller}
          count={upcoming.length}
          className={sort.dragging ? "is-sorting" : undefined}
          getKey={(i) => upcoming[i].key}
          renderRow={(i, enter) => {
            const item = upcoming[i];
            const pos = first + i;
            return (
              <QueueRow
                track={item}
                pos={pos}
                enter={enter}
                transform={sort.transformFor(pos)}
                dragging={sort.isDragged(pos)}
                handleRef={sort.handleRef(item.key)}
                handleProps={sort.handlePropsFor(item.key, pos)}
              />
            );
          }}
        />
      ) : (
        <p className="lnote">
          {repeat === "all" ? "Al terminar vuelve a empezar." : "No hay nada más en la cola."}
        </p>
      )}
    </>
  );
}
