import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.jsx";
import { clamp, cx } from "./ui.jsx";
import { usePc } from "./viewport.js";
import { pushSample, resistedDy, scrimOpacity, shouldDismiss, velocity, SLOP } from "./gestures.js";
import { HAPTIC, haptic } from "./haptics.js";
import { motion, motionAfter } from "./motion.js";
import "./sheet.css";

/* ---------------------------------------------------------------------------
   HOJA

   El cuadro modal de la app: en telefono sube desde abajo (hoja con asa), desde
   960 px es una tarjeta centrada. Quien la pinta decide cuando existe; cerrarla
   (aqui, el fondo) llama a `onClose`, que en Buscar es nav.back(): la hoja vive
   en la pila de navegacion, asi que Escape y el atras del navegador/Android la
   cierran sin teclas propias.

   Foco: entra en `[data-autofocus]` o, si no hay, en el primer control, cuando
   ya termino la entrada (con movimiento reducido, en el mismo tick); Tab no
   sale de la hoja; al desmontarse vuelve a `anchor` (el boton que la abrio: el
   toque no siempre lo enfoca) o, sin el, a quien lo tenia.

   Salida: el asa y la cabecera arrastran con la MISMA aritmetica del
   reproductor (gestures.js). El cuerpo sigue al dedo, el scrim se desvanece con
   el mismo progreso y soltar decide por 35 % o 0,5 px/ms. `closing` aplaza el
   desmontaje y el desbloqueo del scroll hasta que termina la animacion; abrir
   otra hoja mientras esta cierra cancela ese cierre pendiente.
   ------------------------------------------------------------------------- */

const FOCUSABLE = 'button:not(:disabled), a[href], input, [tabindex]:not([tabindex="-1"])';
const CLOSE_MS = 280;
const ENTER_MS = 240;
/* Solo una hoja puede cerrarse a la vez: una nueva gana y la anterior se queda. */
let latestSheet = 0;

/* Cabecera de las hojas de menu: titulo y cierre. La comparten el menu de
   resultados y el de resoluciones, asi que el texto y el boton no se repiten. */
/* `quiet`: el titulo solo para el lector, cuando debajo ya hay una cabecera
   que dice lo mismo (la portada y el nombre de la cancion). */
export function SheetBar({ title, onClose, quiet }) {
  return (
    <div className="sh__bar">
      <h2 className={quiet ? "sr-only" : "sh__bt"}>{title}</h2>
      <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar" onClick={onClose}>
        <Icon name="X" size="sm" />
      </button>
    </div>
  );
}

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
  const scrim = useRef(null);
  const drag = useRef(null);
  const closeTimer = useRef(null);
  const focusTimer = useRef(null);
  const token = useRef(0);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    token.current = ++latestSheet;
    const opener = document.activeElement;
    /* El teclado no puede subir con la animacion de entrada todavia en curso:
       enfocar antes deja la hoja a media altura cuando el teclado redimensiona. */
    focusTimer.current = motionAfter(() => {
      const el = box.current;
      (el?.querySelector("[data-autofocus]") || el?.querySelector(FOCUSABLE))?.focus({ preventScroll: true });
    }, ENTER_MS);
    const unlock = pc ? null : lockScroll();
    return () => {
      focusTimer.current?.();
      closeTimer.current?.();
      unlock?.();
      const back = anchor?.isConnected ? anchor : opener;
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Con adjustResize, el teclado cambia el alto REAL de la ventana. `translate`
     es independiente del `transform` del arrastre: los dos se componen. */
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || pc) return undefined;
    const apply = () => {
      const shift = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      if (box.current) box.current.style.translate = `0 -${shift}px`;
    };
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    apply();
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      if (box.current) box.current.style.translate = "";
    };
  }, [pc]);

  /* Toda salida pasa por aqui: scrim, X y arrastre. La animacion corre y el
     desmontaje se aplaza; una hoja nueva que se abre cancela el cierre viejo. */
  const requestClose = useCallback(
    () => {
      if (closing || !box.current) return;
      setClosing(true);
      const el = box.current;
      const dur = motion(CLOSE_MS);
      /* Salida reversa de `sh-up`: la hoja baja y el scrim se funde, venga el
         cierre del asa, de la X, del fondo o del arrastre. */
      el.style.transition = `transform ${dur ? `${dur}ms` : "0ms"} var(--drawer)`;
      el.style.transform = "translateY(100%)";
      if (scrim.current) {
        scrim.current.style.transition = `opacity ${dur ? `${dur}ms` : "0ms"} var(--drawer)`;
        scrim.current.style.opacity = "0";
      }
      haptic(HAPTIC.CONFIRM);
      closeTimer.current = motionAfter(() => {
        if (token.current === latestSheet) onClose();
      }, CLOSE_MS);
    },
    [closing, onClose]
  );

  /* --- Arrastre del asa y la cabecera (telefono) --------------------------- */

  const onPointerDown = (e) => {
    if (pc || closing || !e.isPrimary || e.pointerType === "mouse") return;
    if (e.target.closest("button, a, input")) return;
    if (!e.target.closest(".sh__grab, .sh__bar, .als__top, .qsh__top, .dsh__top, .fy__top, .fy__grab")) return;
    /* Interrumpe la entrada: una animacion CSS con `both` ganaria al transform
       en linea y el dedo no veria seguir al cuerpo. */
    if (box.current) box.current.style.animation = "none";
    if (scrim.current) scrim.current.style.animation = "none";
    drag.current = {
      id: e.pointerId,
      y: e.clientY,
      dy: 0,
      started: false,
      samples: [[e.clientY, e.timeStamp]],
    };
  };

  const onPointerMove = (e) => {
    const g = drag.current;
    if (!g || e.pointerId !== g.id) return;
    const raw = e.clientY - g.y;
    if (!g.started) {
      if (Math.abs(raw) < SLOP) return;
      if (raw <= 0) {
        drag.current = null;
        return;
      }
      g.started = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* sin captura, el arrastre sigue por los eventos normales */
      }
    }
    const h = box.current?.clientHeight || 1;
    g.dy = resistedDy(raw, h);
    if (box.current) {
      box.current.style.transition = "none";
      box.current.style.transform = `translateY(${g.dy}px)`;
    }
    if (scrim.current) {
      scrim.current.style.transition = "none";
      scrim.current.style.opacity = String(scrimOpacity(g.dy, h));
    }
    pushSample(g.samples, e.clientY, e.timeStamp);
  };

  const onPointerUp = (e) => {
    const g = drag.current;
    drag.current = null;
    if (!g || !g.started) return;
    if (e.type === "pointercancel" || !shouldDismiss(g.dy, velocity(g.samples), box.current?.clientHeight || 1)) {
      const dur = motion(CLOSE_MS);
      if (box.current) {
        box.current.style.transition = `transform ${dur ? `${dur}ms` : "0ms"} var(--ease-spring)`;
        box.current.style.transform = "";
      }
      if (scrim.current) {
        scrim.current.style.transition = `opacity ${dur ? `${dur}ms` : "0ms"} var(--ease)`;
        scrim.current.style.opacity = "1";
      }
      return;
    }
    /* Ya esta desplazada: la salida continua desde donde la dejo el dedo. */
    requestClose();
  };

  /* Las X de las hojas compartidas cierran con la misma salida: se interceptan
     aqui, sin tocar los call sites ni cambiar el contrato de `onClose`. */
  const onCloseClick = (e) => {
    if (!e.target.closest('button[aria-label^="Cerrar"]')) return;
    e.preventDefault();
    e.stopPropagation();
    requestClose();
  };

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
    <div className={cx("sh", closing && "is-closing")} data-no-swipe="">
      <div ref={scrim} className="sh__scrim" aria-hidden="true" onClick={() => requestClose()} />
      <div
        ref={box}
        className={sm ? "sh__box sh__box--sm" : "sh__box"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onKeyDown}
        onClickCapture={onCloseClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
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

export function Popover({ anchor, point, onClose, rev, width = 300, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  const place = useCallback(() => {
    const box = ref.current;
    if (!box || (!anchor?.isConnected && !point)) return;
    /* La altura NATURAL: sin el tope de la colocacion anterior, que la mediria
       ya recortada. El estilo se devuelve tal cual. */
    const prev = box.style.maxHeight;
    box.style.maxHeight = "none";
    const natural = box.offsetHeight || 0;
    box.style.maxHeight = prev;
    /* El clic derecho no tiene boton: un punto del puntero vale de ancla. */
    const rect = point
      ? { top: point.y, bottom: point.y, left: point.x, right: point.x + width, width, height: 0 }
      : anchor.getBoundingClientRect();
    setPos(
      placePop({
        anchor: rect,
        vw: window.innerWidth,
        vh: window.innerHeight,
        natural,
        width,
      })
    );
  }, [anchor, point, width]);

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
