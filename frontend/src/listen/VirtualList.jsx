import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cx } from "../shared/ui.jsx";
import { visibleRange } from "./library.js";

/* ---------------------------------------------------------------------------
   LISTA VIRTUAL

   La biblioteca puede tener miles de filas y la pagina scrollea con la VENTANA
   (App guarda y restaura window.scrollY por pantalla), asi que no hay un
   contenedor con scroll propio: la lista mide donde esta respecto al viewport
   y monta solo las filas que caben mas un margen.

   Con alto fijo la fila i vive en i * ROW_H y no hace falta medir ninguna.
   Cada fila va en una caja con translateY y su contenido dentro: asi la
   animacion de entrada (que tambien usa transform) y el desplazamiento de la
   cola al reordenar no pisan la posicion.

   `scroller` (una ref a un elemento) cambia quien scrollea: la cola de "Ahora
   suena" vive en su propio contenedor, y entonces se escucha ESE scroll y se
   mide contra su caja en vez de contra la ventana.
   ------------------------------------------------------------------------- */

/* Alto de cada fila. DEBE coincidir con --row-h de listen.css. */
export const ROW_H = 56;

const OVERSCAN = 6;
/* Lo que dura la cascada de entrada de la primera pintura. Pasado este margen
   las filas que monta el scroll ya no se animan. */
const INTRO_MS = 700;

const VirtualList = forwardRef(function VirtualList(
  { count, active, getKey, renderRow, className, scroller },
  ref
) {
  const boxRef = useRef(null);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const intro = useRef({ until: 0, from: 0 });

  const measure = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    /* La ref del contenedor se engancha tras los layout effects de sus hijos:
       la primera medida puede caer aun sin el y cae a la ventana; el effect
       de abajo la repite ya con el. */
    const sc = scroller?.current;
    const top = sc ? sc.getBoundingClientRect().top : 0;
    const next = visibleRange({
      scrollTop: top - box.getBoundingClientRect().top,
      viewport: sc ? sc.clientHeight : window.innerHeight,
      rowHeight: ROW_H,
      count,
      overscan: OVERSCAN,
    });
    /* Solo se repinta si cambia la ventana: el scroll dispara decenas de
       eventos por segundo y casi todos caen dentro de la misma ventana. */
    setRange((cur) => (cur.start === next.start && cur.end === next.end ? cur : next));
  }, [count, scroller]);

  /* Oculta (otra pantalla) la caja mide 0: no hay nada que calcular. */
  useLayoutEffect(() => {
    if (active) measure();
  }, [active, measure]);

  useEffect(() => {
    if (!active) return undefined;
    /* App restaura el scroll de la pantalla en su layout effect, que corre
       DESPUES del de este hijo: se vuelve a medir con el scroll ya puesto. */
    measure();
    const target = scroller?.current || window;
    target.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      target.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [active, measure, scroller]);

  useImperativeHandle(
    ref,
    () => ({
      /* Centra la fila en el viewport. El hueco de la cabecera pegajosa no se
         descuenta: centrada queda lejos de ella en cualquier pantalla. */
      scrollToIndex(i) {
        const box = boxRef.current;
        if (!box) return;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const sc = scroller?.current;
        const top = sc
          ? box.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop + i * ROW_H + ROW_H / 2 - sc.clientHeight / 2
          : box.getBoundingClientRect().top + window.scrollY + i * ROW_H + ROW_H / 2 - window.innerHeight / 2;
        (sc || window).scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
      },
    }),
    [scroller]
  );

  /* El conteo puede bajar entre el render y el layout effect que re-mide. */
  const end = Math.min(range.end, count);
  const start = Math.min(range.start, end);
  const now = performance.now();
  if (end > start && intro.current.until === 0) {
    intro.current = { until: now + INTRO_MS, from: start };
  }
  const entering = now < intro.current.until;

  const rows = [];
  for (let i = start; i < end; i++) {
    rows.push(
      <div
        key={getKey(i)}
        className="vrow"
        role="listitem"
        aria-posinset={i + 1}
        aria-setsize={count}
        style={{ transform: `translateY(${i * ROW_H}px)` }}
      >
        {renderRow(i, entering ? Math.max(0, i - intro.current.from) : undefined)}
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      className={cx("vlist", className)}
      role="list"
      style={{ height: count * ROW_H }}
    >
      {rows}
    </div>
  );
});

export default VirtualList;
