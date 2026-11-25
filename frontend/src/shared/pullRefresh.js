import { useEffect, useRef } from "react";
import { HAPTIC, haptic } from "./haptics.js";
import { motionAfter } from "./motion.js";

/* ---------------------------------------------------------------------------
   PULL TO REFRESH (U-mobile-native-feel-10)

   Solo donde puede llegar algo nuevo: Inicio y «Para ti». El dedo baja con
   resistencia, el indicador gira al pasar el umbral (un unico detente haptic,
   no uno por fotograma) y soltar por encima del umbral pide el refresco. El
   WebView lleva OVER_SCROLL_NEVER, asi que no aparece el brillo de Android.
   ------------------------------------------------------------------------- */

export const PULL_THRESHOLD = 64;

export function pullOffset(raw) {
  if (raw <= 0) return 0;
  return raw < PULL_THRESHOLD
    ? raw * 0.5
    : PULL_THRESHOLD + (raw - PULL_THRESHOLD) * 0.25;
}

export const shouldRefresh = (offset) => offset >= PULL_THRESHOLD;

export function usePullRefresh(onRefresh, enabled = true, externalRef = null) {
  const ownRef = useRef(null);
  const ref = externalRef || ownRef;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || typeof onRefresh !== "function") return undefined;

    const ind = document.createElement("div");
    ind.className = "pull-ind";
    ind.setAttribute("aria-hidden", "true");
    document.body.appendChild(ind);

    let y0 = 0;
    let offset = 0;
    let armed = false;
    let active = false;

    const atTop = () => {
      /* El contenedor de pantallas no scrollea: lo hace la ventana. */
      const scrolls = el.scrollHeight > el.clientHeight + 1;
      return scrolls ? el.scrollTop <= 0 : window.scrollY <= 0;
    };

    const reset = () => {
      active = false;
      armed = false;
      offset = 0;
      ind.classList.remove("is-pulling", "is-ready");
      ind.style.opacity = "";
      delete el.dataset.pull;
      el.style.removeProperty("--pull");
    };

    const down = (e) => {
      if (active || e.touches.length !== 1 || !atTop()) return;
      active = true;
      y0 = e.touches[0].clientY;
      offset = 0;
      armed = false;
    };

    const move = (e) => {
      if (!active || e.touches.length !== 1) return;
      const raw = e.touches[0].clientY - y0;
      if (raw <= 0) {
        if (offset) reset();
        return;
      }
      e.preventDefault(); /* El dedo tira de la lista: no la desplaza. */
      offset = pullOffset(raw);
      const ready = shouldRefresh(offset);
      if (ready && !armed) haptic(HAPTIC.DETENT);
      armed = ready;
      ind.classList.add("is-pulling");
      ind.classList.toggle("is-ready", ready);
      ind.style.opacity = String(Math.min(1, offset / PULL_THRESHOLD));
      el.dataset.pull = ready ? "ready" : "pulling";
      el.style.setProperty("--pull", `${offset}px`);
    };

    const end = () => {
      if (!active) return;
      const fire = armed;
      reset();
      if (fire) motionAfter(onRefresh, 200);
    };

    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      ind.remove();
      reset();
    };
  }, [onRefresh, enabled]);

  return ref;
}
