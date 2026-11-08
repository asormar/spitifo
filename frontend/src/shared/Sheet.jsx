import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clamp, cx } from "./ui.jsx";
import { usePc } from "./viewport.js";
import "./sheet.css";

/* ---------------------------------------------------------------------------
   HOJA

   El cuadro modal de la app: en telefono sube desde abajo (hoja con asa), desde
   960 px es una tarjeta centrada. Quien la pinta decide cuando existe; cerrarla
   (aqui, el fondo) llama a `onClose`, que en Buscar es nav.back(): la hoja vive
   en la pila de navegacion, asi que Escape y el atras del navegador/Android la
   cierran sin teclas propias.

   Foco: entra en `[data-autofocus]` o, si no hay, en el primer control; Tab no
   sale de la hoja; al desmontarse vuelve a `anchor` (el boton que la abrio: el
   toque no siempre lo enfoca) o, sin el, a quien lo tenia. Sin animacion de
   salida: se desmonta al instante.
   ------------------------------------------------------------------------- */

const FOCUSABLE = 'button:not(:disabled), a[href], input, [tabindex]:not([tabindex="-1"])';

/* Con una hoja abierta (telefono) la pagina de debajo no se desplaza. Cuenta
   las que hay: la ficha y su hoja de resoluciones pueden estar a la vez. */
let locks = 0;
export function lockScroll() {
  const root = document.documentElement;
  if (!locks++) root.classList.add("sheet-lock");
  return () => {
    if (!--locks) root.classList.remove("sheet-lock");
  };
}

export default function Sheet({ title, onClose, anchor, sm, children }) {
  const pc = usePc();
  const box = useRef(null);

  useEffect(() => {
    const opener = document.activeElement;
    const el = box.current;
    (el.querySelector("[data-autofocus]") || el.querySelector(FOCUSABLE))?.focus({ preventScroll: true });
    const unlock = pc ? null : lockScroll();
    return () => {
      unlock?.();
      const back = anchor?.isConnected ? anchor : opener;
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* El foco no sale de la hoja con Tab. */
  const onKeyDown = (e) => {
    if (e.key !== "Tab") return;
    const items = [...box.current.querySelectorAll(FOCUSABLE)];
    if (!items.length) return;
    const edge = e.shiftKey ? 0 : items.length - 1;
    if (items.indexOf(document.activeElement) !== edge && box.current.contains(document.activeElement)) return;
    e.preventDefault();
    items[e.shiftKey ? items.length - 1 : 0].focus();
  };

  return createPortal(
    <div className="sh" data-no-swipe="">
      <div className="sh__scrim" onClick={onClose} />
      <div ref={box} className={sm ? "sh__box sh__box--sm" : "sh__box"} role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown}>
        <div className="sh__grab" aria-hidden="true" />
        {children}
      </div>
    </div>,
    document.body
  );
}

/* ---------------------------------------------------------------------------
   POPOVER

   Escritorio: fixed junto al boton, alineado a su borde derecho; si abajo no
   cabe y arriba si, se abre hacia arriba (y la animacion nace de abajo). Va en
   un portal a <body>: dentro de la fila lo recortarian el overflow de la
   pagina y su z-index quedaria por debajo del reproductor de video. Lo usan el
   menu de resoluciones de Buscar y los menus de la biblioteca; cerrarlo
   (fuera, Tab, scroll de la pagina) llama a `onClose`, que es nav.back().
   No bloquea el scroll: si la pagina se mueve, el menu se cierra, porque
   quedaria suelto de su boton.
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

export function Popover({ anchor, onClose, rev, width = 300, children }) {
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
    /* Cierra una sola vez: onClose es nav.back() y una segunda llamada sacaria
       tambien la pagina de debajo. */
    let closed = false;
    const close = () => closed || ((closed = true), onClose());
    /* Tocar fuera cierra, pero ARRASTRAR no: se escucha click, que solo existe
       si hubo un toque. El boton se excluye: su click ya alterna. */
    const outside = (e) => {
      if (!box.contains(e.target) && !anchor?.contains(e.target)) close();
    };
    /* El scroll no burbujea: en captura se ven los de la ventana y los de
       cualquier contenedor, salvo el del propio menu. */
    const scrolled = (e) => box.contains(e.target) || close();
    document.addEventListener("click", outside, true);
    document.addEventListener("scroll", scrolled, { capture: true, passive: true });
    return () => {
      document.removeEventListener("click", outside, true);
      document.removeEventListener("scroll", scrolled, true);
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
