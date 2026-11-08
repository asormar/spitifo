import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { lockScroll } from "./Sheet.jsx";
import { clamp, cx } from "./ui.jsx";
import "./sheet.css";

/* ---------------------------------------------------------------------------
   POPOVER

   Escritorio: fixed junto al boton, alineado a su borde derecho; si abajo no
   cabe y arriba si, se abre hacia arriba (y la animacion nace de abajo). Va en
   un portal a <body>: dentro de la fila lo recortarian el overflow de la
   pagina y su z-index quedaria por debajo del reproductor de video. Lo usan el
   menu de resoluciones de Buscar y los menus de la biblioteca; cerrarlo
   (fuera, Tab) llama a `onClose`, que es nav.back().
   ------------------------------------------------------------------------- */

const GAP = 6;

/* Puro: donde cae un popover de `width` junto al rectangulo `anchor` en una
   ventana de vw x vh, con `natural` de alto sin recortar. */
export function placePop({ anchor, vw, vh, natural, width = 300 }) {
  const w = Math.min(width, vw - 16);
  const below = vh - (anchor.bottom + GAP) - 8;
  const above = anchor.top - GAP - 8;
  const up = natural > below && above > below;
  return {
    top: Math.max(8, up ? anchor.top - GAP - Math.min(natural, above) : anchor.bottom + GAP),
    left: clamp(anchor.right - w, 8, Math.max(8, vw - w - 8)),
    width: w,
    maxH: Math.max(140, up ? above : below),
    up,
  };
}

export default function Popover({ anchor, onClose, rev, width = 300, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  const place = useCallback(() => {
    const box = ref.current;
    if (!box || !anchor?.isConnected) return;
    /* La altura NATURAL: sin el tope de la colocacion anterior, que la mediria
       ya recortada. El estilo se devuelve tal cual. */
    const prev = box.style.maxHeight;
    box.style.maxHeight = "none";
    const natural = box.offsetHeight || 0;
    box.style.maxHeight = prev;
    setPos(
      placePop({
        anchor: anchor.getBoundingClientRect(),
        vw: window.innerWidth,
        vh: window.innerHeight,
        natural,
        width,
      })
    );
  }, [anchor, width]);

  /* Vuelve a colocarse cuando llega la lista (cambia la altura). */
  useLayoutEffect(() => {
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [place, rev]);

  useEffect(() => {
    if (anchor && !anchor.isConnected) onClose();
    const box = ref.current;
    box.querySelector("[data-autofocus]")?.focus({ preventScroll: true });
    /* Tocar fuera cierra, pero ARRASTRAR no: se escucha click, que solo existe
       si hubo un toque. El boton se excluye: su click ya alterna. */
    const outside = (e) => {
      if (!box.contains(e.target) && !anchor?.contains(e.target)) onClose();
    };
    document.addEventListener("click", outside, true);
    const unlock = lockScroll();
    return () => {
      document.removeEventListener("click", outside, true);
      unlock();
      /* El foco vuelve al boton, salvo que el toque fuera lo haya llevado a otro
         control. */
      const at = document.activeElement;
      if ((!at || at === document.body) && anchor?.isConnected) anchor.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Tab cierra y deja el foco en el boton: el menu es un portal al final del
     <body> y sin esto el tabulado siguiente caeria lejos de la fila. */
  const onKeyDown = (e) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    onClose();
  };

  return createPortal(
    <div
      ref={ref}
      className={cx("pop", pos && "is-placed", pos?.up && "is-up")}
      data-no-swipe=""
      style={pos ? { top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH } : undefined}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body
  );
}
