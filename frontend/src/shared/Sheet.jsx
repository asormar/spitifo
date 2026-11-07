import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
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

/* Con una hoja o un menu abiertos la pagina de debajo no se desplaza. Cuenta
   las que hay: la ficha y su menu de resoluciones pueden estar a la vez. */
let locks = 0;
export function lockScroll() {
  const root = document.documentElement;
  if (!locks++) root.classList.add("rsvm-lock");
  return () => {
    if (!--locks) root.classList.remove("rsvm-lock");
  };
}

export default function Sheet({ title, onClose, anchor, children }) {
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
      <div ref={box} className="sh__box" role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown}>
        <div className="sh__grab" aria-hidden="true" />
        {children}
      </div>
    </div>,
    document.body
  );
}
