/* ---------------------------------------------------------------------------
   DESLIZAR PARA QUITAR EL AVISO

   El aviso se arrastra en horizontal, hacia cualquier lado, como el snackbar
   de Android. Lo vertical se deja al scroll (`touch-action: pan-y` en el CSS).
   Pasado un tercio del ancho, o con un gesto rapido, sale por donde iba; si no,
   vuelve a su sitio. El transform se pone en el propio aviso: si fuera por una
   variable del padre se recalcularian los estilos de todos los hijos.
   ------------------------------------------------------------------------- */

const SLOP_PX = 8;
const DISMISS_FRACTION = 1 / 3;
/* px/ms, la velocidad media del gesto entero: un golpe corto pero decidido. */
const FLICK_SPEED = 0.11;
const FLICK_MIN_PX = 16;
const OUT_MS = 180; // --t-quick

/* Pura para poder probarla: con lo arrastrado, lo que tardo y el ancho. */
export function swipeOutcome(dx, ms, width) {
  const d = Math.abs(dx);
  if (d >= width * DISMISS_FRACTION) return "dismiss";
  if (ms > 0 && d >= FLICK_MIN_PX && d / ms > FLICK_SPEED) return "dismiss";
  return "back";
}

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Engancha el gesto al nodo del aviso. Devuelve la limpieza. */
export function bindSwipe(el, onDismiss) {
  let id = null;
  let dragging = false;
  let x0 = 0;
  let y0 = 0;
  let t0 = 0;
  let dx = 0;

  const follow = (x) => {
    el.style.transform = `translateX(${x}px)`;
    el.style.opacity = String(Math.max(0.2, 1 - Math.abs(x) / el.offsetWidth));
  };

  const down = (e) => {
    /* Un segundo dedo no toma el gesto: el aviso saltaria. */
    if (id !== null || e.button > 0) return;
    id = e.pointerId;
    x0 = e.clientX;
    y0 = e.clientY;
    t0 = e.timeStamp;
    dx = 0;
    dragging = false;
  };

  const move = (e) => {
    if (e.pointerId !== id) return;
    const mx = e.clientX - x0;
    const my = e.clientY - y0;
    if (!dragging) {
      if (Math.abs(my) > SLOP_PX && Math.abs(my) > Math.abs(mx)) id = null;
      if (id === null || Math.abs(mx) < SLOP_PX) return;
      dragging = true;
      /* Capturado, el gesto sigue aunque el dedo salga del aviso; y el click
         ya no llega al boton, asi que soltar sobre "Deshacer" no deshace. */
      el.setPointerCapture?.(id);
      el.classList.add("is-drag");
      /* Sin la transicion de la vuelta anterior: el aviso va pegado al dedo. */
      el.style.transition = "";
    }
    dx = mx;
    follow(dx);
  };

  const up = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    if (!dragging) return;
    dragging = false;
    const out = e.type === "pointerup" &&
      swipeOutcome(dx, e.timeStamp - t0, el.offsetWidth) === "dismiss";
    el.style.transition = "transform var(--t-quick) var(--ease), opacity var(--t-quick) var(--ease)";
    if (!out) {
      el.style.transform = "";
      el.style.opacity = "";
      return;
    }
    /* Sale por donde iba. Con movimiento reducido solo se desvanece. */
    if (!reducedMotion()) el.style.transform = `translateX(${Math.sign(dx) * el.offsetWidth * 1.2}px)`;
    el.style.opacity = "0";
    setTimeout(onDismiss, OUT_MS);
  };

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
  };
}
