import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clamp } from "../shared/ui.jsx";
import { ROW_H } from "./VirtualList.jsx";

/* ---------------------------------------------------------------------------
   REORDENAR ARRASTRANDO

   La cola y las listas de reproduccion se reordenan igual: arrastrar el asa
   mueve la fila con translateY siguiendo al dedo; las filas de en medio se
   corren una fila para abrir hueco donde va a caer. Aqui vive esa logica, una
   sola vez. Quien la usa solo dice que hacer al soltar (`onMove`) y entre que
   posiciones se puede mover (`first`..`last`).

   `onMove(from, to)` solo se llama al soltar (o con una flecha) y devuelve si
   movio algo. Mientras se arrastra, los datos reales no cambian: cancelar es
   soltar y ya.

   Dentro de Escuchar la pagina es quien scrollea; en "Ahora suena" lo hace su
   propio contenedor, que llega como `scroller` (una ref). Todo lo que mira el
   scroll (el arrastre y su desplazamiento automatico) pasa por `scrollEl`.
   `watch` es lo que cambia cuando el orden cambia (el arreglo de datos): con
   el teclado, mover una fila la saca del DOM y la vuelve a meter, y el foco se
   recupera en el asa de esa misma fila al llegar el nuevo `watch`.
   ------------------------------------------------------------------------- */

/* Franja del borde del viewport donde el arrastre desplaza la pagina. */
const EDGE = 56;

export function useDragSort({ scroller, first, last, onMove, watch }) {
  /* { from, dy }: `from` es la posicion de la fila y `dy` lo que se ha movido,
     descontando lo que scrollea la pagina. La referencia guarda lo mismo para
     los manejadores, que no pueden fiarse de un render que quiza no ha llegado
     todavia. */
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const pointer = useRef(null);
  const handles = useRef(new Map());
  const refocus = useRef(null);

  const scrollEl = () => scroller?.current || window;
  const scrolled = () => scroller?.current?.scrollTop ?? window.scrollY;

  const setDragged = (next) => {
    dragRef.current = next;
    setDrag(next);
  };
  const travelled = () => pointer.current.y - pointer.current.y0 + (scrolled() - pointer.current.s0);
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
        const bottom = p.bottom - EDGE;
        const speed = p.y < top ? (p.y - top) / EDGE : p.y > bottom ? (p.y - bottom) / EDGE : 0;
        if (speed) {
          scrollEl().scrollBy(0, Math.round(clamp(speed, -1, 1) * 18));
          setDragged({ ...d, dy: travelled() });
        }
      }
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [dragging]);

  useLayoutEffect(() => {
    if (refocus.current === null) return;
    handles.current.get(refocus.current)?.focus();
    refocus.current = null;
  }, [watch]);

  /* `id` identifica la fila (su clave) para devolverle el foco. */
  const handleRef = (id) => (el) => (el ? handles.current.set(id, el) : handles.current.delete(id));

  const handlePropsFor = (id, pos) => ({
    onPointerDown(e) {
      if (e.button > 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const sc = scroller?.current;
      pointer.current = {
        y0: e.clientY,
        y: e.clientY,
        s0: scrolled(),
        inset: sc ? sc.getBoundingClientRect().top : document.querySelector(".ltool")?.getBoundingClientRect().bottom ?? 0,
        bottom: sc ? sc.getBoundingClientRect().bottom : window.innerHeight,
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
      if (dest !== d.from) onMove(d.from, dest);
    },
    onPointerCancel() {
      setDragged(null);
    },
    onKeyDown(e) {
      const step = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      if (onMove(pos, pos + step)) refocus.current = id;
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

  return {
    dragging,
    isDragged: (pos) => dragging && drag.from === pos,
    handleRef,
    handlePropsFor,
    transformFor,
  };
}
