import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchErr } from "../shared/api.js";
import { fmtApproxSize } from "../shared/format.js";
import Sheet, { lockScroll } from "../shared/Sheet.jsx";
import { clamp, cx } from "../shared/ui.jsx";
import { usePc } from "../shared/viewport.js";
import { fetchFormats, formatsCache } from "./api.js";
import Ico from "./ico.jsx";

/* ---------------------------------------------------------------------------
   RESOLUCIONES DE UN VIDEO DE YOUTUBE

   Con «Solo vídeo» o «Audio y vídeo» el boton de descarga no baja: abre este
   menu con las alturas reales del video (GET /api/formats). UNA instancia, la de
   la pantalla: abrir uno cierra el anterior. Telefono: hoja; escritorio: un
   popover junto al boton. Vive en la pila de navegacion (resmenu), asi que
   Escape, atras y el atras de Android lo cierran: `onClose` es nav.back().

   El primer item baja sin `height` (lo mejor disponible); cada uno de los
   siguientes, una altura concreta.
   ------------------------------------------------------------------------- */

/* Pide las resoluciones (de la cache si ya se pregunto por este video). Cerrar
   cancela la peticion en vuelo. El muro de verificacion de YouTube llega como
   fallo con codigo: mismo aviso que la descarga y el menu se cierra. */
function useFormats(url, onBotCheck, onClose) {
  const [st, setSt] = useState(() => {
    const data = formatsCache.get(url);
    return data ? { phase: "list", data } : { phase: "loading" };
  });
  const abort = useRef(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setSt({ phase: "loading" });
    try {
      const data = await fetchFormats(url, ac.signal);
      if (!ac.signal.aborted) setSt({ phase: "list", data });
    } catch (e) {
      if (e?.name === "AbortError" || ac.signal.aborted) return;
      if (e.code === "youtube_bot_check") {
        onClose();
        onBotCheck(e.message);
        return;
      }
      setSt({ phase: "error", error: fetchErr(e, e.message) });
    }
  }, [url, onBotCheck, onClose]);

  useEffect(() => {
    if (!formatsCache.get(url)) load();
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return { st, load };
}

const KEYS = { ArrowDown: 1, ArrowUp: -1 };

function Body({ st, load, title, onPick }) {
  const ref = useRef(null);
  const list = st.data?.resolutions || [];
  const best = list[0];

  /* Flechas, Inicio y Fin entre los items; Escape lo cierra nav.back(). */
  const onKeyDown = (e) => {
    const items = [...ref.current.querySelectorAll('[role="menuitem"]')];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    const to =
      e.key in KEYS
        ? (at + KEYS[e.key] + items.length) % items.length
        : e.key === "Home"
        ? 0
        : e.key === "End"
        ? items.length - 1
        : null;
    if (to === null) return;
    e.preventDefault();
    items[to].focus();
  };

  return (
    <div
      ref={ref}
      className="rm"
      role="menu"
      aria-label={`Resoluciones de ${title}`}
      tabIndex={-1}
      data-autofocus=""
      onKeyDown={onKeyDown}
    >
      {st.phase === "loading" && (
        <p className="rm__msg" aria-live="polite">
          <span className="sp" aria-hidden="true" />
          Buscando resoluciones…
        </p>
      )}
      {st.phase === "error" && (
        <div role="alert">
          <p className="rm__msg rm__msg--err">{st.error}</p>
          <button type="button" role="menuitem" className="rm__i" onClick={load}>
            <span className="rm__h">
              <Ico n="retry" size={16} />
              Reintentar
            </span>
          </button>
        </div>
      )}
      {st.phase === "list" && (
        <>
          <button type="button" role="menuitem" className="rm__i rm__i--best" onClick={() => onPick(null)}>
            <span className="rm__h">Mejor disponible</span>
            {best && (
              <span className="rm__d num">
                {best.label || `${best.height}p`}
                {best.fps ? ` · ${best.fps} fps` : ""} · {fmtApproxSize(best.filesize)}
              </span>
            )}
          </button>
          {list.map((r) => (
            <button key={r.height} type="button" role="menuitem" className="rm__i" onClick={() => onPick(r.height)}>
              <span className="rm__h">
                {r.label || `${r.height}p`}
                {r.hdr && <span className="rm__hdr">HDR</span>}
              </span>
              <span className="rm__d num">
                {r.fps ? <span className={cx(r.fps >= 50 && "rm__fps")}>{r.fps} fps · </span> : null}
                {fmtApproxSize(r.filesize)}
              </span>
            </button>
          ))}
          {list.length === 0 && <p className="rm__msg">Este vídeo no ofrece resoluciones sueltas.</p>}
        </>
      )}
    </div>
  );
}

/* Escritorio: fixed junto al boton, 300 de ancho, alineado a su borde derecho; si
   abajo no cabe y arriba si, se abre hacia arriba. Va en un portal a <body>: dentro
   de la fila lo recortarian el overflow de la pagina y su z-index quedaria por
   debajo del reproductor de video. */
function Popover({ anchor, onClose, rev, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  const place = useCallback(() => {
    const box = ref.current;
    if (!box || !anchor?.isConnected) return;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(300, vw - 16);
    /* La altura NATURAL: sin el tope de la colocacion anterior, que la mediria
       ya recortada. El estilo se devuelve tal cual. */
    const prev = box.style.maxHeight;
    box.style.maxHeight = "none";
    const natural = box.offsetHeight || 0;
    box.style.maxHeight = prev;
    const gap = 6;
    const below = vh - (r.bottom + gap) - 8;
    const above = r.top - gap - 8;
    const up = natural > below && above > below;
    setPos({
      top: Math.max(8, up ? r.top - gap - Math.min(natural, above) : r.bottom + gap),
      left: clamp(r.right - width, 8, Math.max(8, vw - width - 8)),
      width,
      maxH: Math.max(140, up ? above : below),
    });
  }, [anchor]);

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
      className={cx("pop", pos && "is-placed")}
      data-no-swipe=""
      style={pos ? { top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH } : undefined}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body
  );
}

export default function ResolutionMenu({ t, anchor, onPick, onClose, onBotCheck }) {
  const pc = usePc();
  const { st, load } = useFormats(t.extra.webpage_url, onBotCheck, onClose);
  const body = <Body st={st} load={load} title={t.title || "este resultado"} onPick={onPick} />;

  /* Al cerrarse el foco vuelve al boton que lo abrio (en el telefono el toque no
     siempre lo enfoca, asi que la hoja no lo recuerda sola). */
  useEffect(
    () => () => {
      if (anchor?.isConnected) anchor.focus({ preventScroll: true });
    },
    [anchor]
  );

  if (pc) {
    return (
      <Popover anchor={anchor} onClose={onClose} rev={st.phase}>
        {body}
      </Popover>
    );
  }
  return (
    <Sheet title="Elige la resolución de la descarga" onClose={onClose} anchor={anchor}>
      <div className="sh__bar">
        <h2 className="sh__bt">Elige la resolución de la descarga</h2>
        <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar" onClick={onClose}>
          <Ico n="x" size={18} />
        </button>
      </div>
      {body}
    </Sheet>
  );
}
