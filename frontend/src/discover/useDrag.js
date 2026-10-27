import { useEffect, useRef } from "react";
import { lockAxis } from "./gestures.js";
import { releaseVelocity } from "./map.js";

/* ---------------------------------------------------------------------------
   ARRASTRE

   Un solo camino para dedo, lapiz y raton: Pointer Events con captura. El
   gesto no empieza al tocar sino al pasar `slop` px en el eje pedido; si gana
   el otro eje se abandona (`lockAxis`) y el navegador se queda con el scroll.
   Eso exige `touch-action` en el elemento: `pan-y` para un arrastre horizontal
   (el dedo vertical sigue desplazando la lista) y `none` para uno vertical.

   Solo el pointerdown y el click van en el elemento; el movimiento y el final
   se escuchan en `window` desde que se toca. Asi un movimiento rapido que sale
   del elemento antes de que el gesto empiece no se pierde (la captura solo se
   puede pedir una vez pasado el umbral: pedirla al tocar mandaria el click al
   contenedor y los botones de dentro dejarian de responder).

   Devuelve los manejadores para poner en el elemento. Despues de un arrastre
   el `click` que el navegador dispara al soltar se descarta, para que mover
   una fila o una hoja no pulse el boton que quedo debajo.

   Callbacks (todos opcionales): canStart(e), shouldStart({ dx, dy }),
   onStart(e), onMove({ dx, dy, e }), onEnd({ dx, dy, vx, vy, cancelled, e }).
   ------------------------------------------------------------------------- */

export function useDrag({ axis, slop = 6, ...callbacks }) {
  const cb = useRef(callbacks);
  cb.current = callbacks;
  const st = useRef(null);
  const swallow = useRef(false);
  const handlers = useRef(null);

  const detach = () => {
    if (!handlers.current) return;
    const { move, up, cancel } = handlers.current;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    handlers.current = null;
  };
  useEffect(() => detach, []);

  const finish = (e, cancelled) => {
    const s = st.current;
    if (!s || s.id !== e.pointerId) return;
    st.current = null;
    detach();
    if (!s.started) return;
    s.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    const v = releaseVelocity(s.samples, e.timeStamp);
    /* El click que sigue a este arrastre no debe pulsar nada. */
    swallow.current = true;
    try {
      s.el.releasePointerCapture(s.id);
    } catch {
      /* Ya liberado. */
    }
    cb.current.onEnd?.({ dx: e.clientX - s.x0, dy: e.clientY - s.y0, vx: v.vx, vy: v.vy, cancelled, e });
  };

  const move = (e) => {
    const s = st.current;
    if (!s || s.id !== e.pointerId) return;
    /* El raton se solto fuera de la ventana: no hay pointerup que esperar. */
    if (e.pointerType === "mouse" && e.buttons === 0) {
      st.current = null;
      detach();
      return;
    }
    const dx = e.clientX - s.x0;
    const dy = e.clientY - s.y0;
    s.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    if (s.samples.length > 8) s.samples.shift();
    if (!s.started) {
      const lock = lockAxis(dx, dy, axis, slop);
      if (lock === null) return;
      if (lock === "cancel" || (cb.current.shouldStart && !cb.current.shouldStart({ dx, dy }))) {
        st.current = null;
        detach();
        return;
      }
      s.started = true;
      try {
        s.el.setPointerCapture(s.id);
      } catch {
        /* El gesto sigue con los eventos de window. */
      }
      cb.current.onStart?.(e);
    }
    cb.current.onMove?.({ dx, dy, e });
  };

  return {
    onPointerDown(e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (cb.current.canStart && !cb.current.canStart(e)) return;
      detach();
      swallow.current = false;
      st.current = {
        id: e.pointerId,
        el: e.currentTarget,
        x0: e.clientX,
        y0: e.clientY,
        started: false,
        samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }],
      };
      handlers.current = { move, up: (ev) => finish(ev, false), cancel: (ev) => finish(ev, true) };
      window.addEventListener("pointermove", handlers.current.move);
      window.addEventListener("pointerup", handlers.current.up);
      window.addEventListener("pointercancel", handlers.current.cancel);
    },
    onClickCapture(e) {
      if (!swallow.current) return;
      swallow.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
  };
}
