import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clamp } from "../shared/ui.jsx";
import { engine } from "../player/engine.js";
import { useEngine } from "../player/useEngine.js";
import VirtualList, { ROW_H } from "./VirtualList.jsx";
import { QueueRow } from "./rows.jsx";

/* ---------------------------------------------------------------------------
   COLA

   Lo que suena arriba y, debajo, lo que falta por sonar en una lista virtual.
   Se pide al motor la cola y el indice por separado: `state.queue` es el mismo
   arreglo hasta que la cola cambia, asi que el timeupdate (cuatro veces por
   segundo) no repinta nada aqui.

   REORDENAR. Arrastrar el asa mueve la fila con translateY siguiendo al dedo;
   las filas de en medio se corren una fila para abrir hueco donde va a caer.
   El motor solo se toca al soltar (engine.move una vez): mientras se arrastra
   la cola real no cambia, asi que cancelar es soltar y ya.
   ------------------------------------------------------------------------- */

/* Franja del borde del viewport donde el arrastre desplaza la pagina. */
const EDGE = 56;

export default function QueueList({ active }) {
  const queue = useEngine((s) => s.queue);
  const index = useEngine((s) => s.index);
  const track = useEngine((s) => s.track);
  const repeat = useEngine((s) => s.repeat);

  const upcoming = useMemo(() => (index >= 0 ? queue.slice(index + 1) : []), [queue, index]);
  const first = index + 1;
  const last = queue.length - 1;

  /* { from, dy }: `from` es la posicion en la cola del motor y `dy` lo que se
     ha movido la fila, descontando lo que scrollea la pagina. La referencia
     guarda lo mismo para los manejadores, que no pueden fiarse de un render
     que quiza no ha llegado todavia. */
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const pointer = useRef(null);
  const handles = useRef(new Map());
  const refocus = useRef(null);

  const setDragged = (next) => {
    dragRef.current = next;
    setDrag(next);
  };
  const travelled = () => pointer.current.y - pointer.current.y0 + (window.scrollY - pointer.current.s0);
  const landing = (d) => clamp(d.from + Math.round(d.dy / ROW_H), first, last);

  const dragging = drag !== null;
  const to = dragging ? landing(drag) : -1;

  /* Cerca del borde de arriba o abajo la pagina se desplaza sola. El borde de
     arriba cuenta desde la barra pegajosa, que es lo que realmente tapa. */
  useEffect(() => {
    if (!dragging) return undefined;
    let raf = requestAnimationFrame(function tick() {
      const p = pointer.current;
      const d = dragRef.current;
      if (p && d) {
        const top = p.inset + EDGE;
        const bottom = window.innerHeight - EDGE;
        const speed = p.y < top ? (p.y - top) / EDGE : p.y > bottom ? (p.y - bottom) / EDGE : 0;
        if (speed) {
          window.scrollBy(0, Math.round(clamp(speed, -1, 1) * 18));
          setDragged({ ...d, dy: travelled() });
        }
      }
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [dragging]);

  /* Teclado: mover una fila la saca del DOM y la vuelve a meter, y el foco se
     pierde. Se recupera en el asa de esa misma pista. */
  useLayoutEffect(() => {
    if (refocus.current === null) return;
    handles.current.get(refocus.current)?.focus();
    refocus.current = null;
  }, [queue]);

  if (!track) {
    return <p className="lnote">La cola está vacía. Toca una canción para empezar.</p>;
  }

  const handlePropsFor = (item, pos) => ({
    onPointerDown(e) {
      if (e.button > 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      pointer.current = {
        y0: e.clientY,
        y: e.clientY,
        s0: window.scrollY,
        inset: document.querySelector(".ltool")?.getBoundingClientRect().bottom ?? 0,
      };
      setDragged({ from: pos, dy: 0 });
    },
    onPointerMove(e) {
      if (!dragRef.current) return;
      pointer.current.y = e.clientY;
      setDragged({ ...dragRef.current, dy: travelled() });
    },
    onPointerUp() {
      const d = dragRef.current;
      if (!d) return;
      setDragged(null);
      const dest = landing(d);
      if (dest !== d.from) engine.move(d.from, dest);
    },
    onPointerCancel() {
      setDragged(null);
    },
    onKeyDown(e) {
      const step = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      if (engine.move(pos, pos + step)) refocus.current = item.key;
    },
  });

  /* Las filas entre el origen y el destino se corren una fila hacia el hueco
     que deja la arrastrada. */
  const transformFor = (pos) => {
    if (!drag) return undefined;
    if (pos === drag.from) return `translateY(${drag.dy}px) scale(1.02)`;
    if (drag.from < to && pos > drag.from && pos <= to) return `translateY(${-ROW_H}px)`;
    if (drag.from > to && pos >= to && pos < drag.from) return `translateY(${ROW_H}px)`;
    return undefined;
  };

  return (
    <>
      <h2 className="llabel">Sonando</h2>
      <div className="qnow">
        <QueueRow track={track} pos={index} now />
      </div>
      <h2 className="llabel">A continuación</h2>
      {upcoming.length ? (
        <VirtualList
          active={active}
          count={upcoming.length}
          className={dragging ? "is-sorting" : undefined}
          getKey={(i) => upcoming[i].key}
          renderRow={(i, enter) => {
            const item = upcoming[i];
            const pos = first + i;
            return (
              <QueueRow
                track={item}
                pos={pos}
                enter={enter}
                transform={transformFor(pos)}
                dragging={dragging && drag.from === pos}
                handleRef={(el) => (el ? handles.current.set(item.key, el) : handles.current.delete(item.key))}
                handleProps={handlePropsFor(item, pos)}
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
