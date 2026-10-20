import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowClockwise,
  CaretDown,
  Check,
  CircleNotch,
  DownloadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { fetchErr, rowKey } from "../shared/api.js";
import { fmtApproxSize } from "../shared/format.js";
import { cx, clamp } from "../shared/ui.jsx";
import { fetchFormats, formatsCache } from "./api.js";

/* Boton de descarga cuadrado con los tres estados de siempre (bajar, en curso,
   ya bajado). Es el boton unico: en YouTube con video lo reemplaza el dividido
   que abre el menu de resoluciones. */
export function DlButton({ busy, downloaded, title, ariaLabel, onClick }) {
  return (
    <button className="dl" disabled={busy} onClick={onClick} title={title} aria-label={ariaLabel}>
      {busy ? (
        <span className="swap" key="busy">
          <CircleNotch size={19} className="spin" />
        </span>
      ) : downloaded ? (
        <span className="swap" key="done">
          <Check size={19} weight="bold" />
        </span>
      ) : (
        <span className="swap" key="idle">
          <DownloadSimple size={19} weight="bold" />
        </span>
      )}
    </button>
  );
}
/* Descarga de un video de YouTube: boton dividido + menu de resoluciones.

   Con "Solo audio" el boton baja directo (lo de siempre). Con video el boton NO
   baja: abre un menu con las alturas que ofrece ese video (GET /api/formats).
   El primer item baja sin `height` (lo mejor disponible) y cada uno de los
   siguientes, una altura concreta.

   El menu vive en un portal a <body>: dentro de la tarjeta lo recortarian el
   `overflow-x: clip` de la pagina y el cajon de la biblioteca, y su z-index
   quedaria por debajo del reproductor de video. */
export function VideoSplitDownload({
  t,
  busy,
  downloaded,
  onDownload,
  onBotCheck,
  menuOpen,
  setMenuOpen,
}) {
  const key = rowKey(t);
  const url = t.extra?.webpage_url;
  const title = t.title || "este resultado";
  const menuId = useId();
  /* phase: loading | list | error. Nunca hay "cerrado" a medias: si no hay
     menu, no hay estado que mostrar. */
  const [phase, setPhase] = useState("loading");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const abortRef = useRef(null);
  const open = menuOpen;

  const closeMenu = useCallback(
    (focusButton) => {
      /* Cerrar cancela la peticion en vuelo: un menu que ya no esta no tiene
         por que seguir preguntando. */
      abortRef.current?.abort();
      abortRef.current = null;
      setMenuOpen(key, false);
      if (focusButton) btnRef.current?.focus();
    },
    [key, setMenuOpen]
  );

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase("loading");
    setError(null);
    try {
      const d = await fetchFormats(url, ac.signal);
      if (ac.signal.aborted) return;
      setData(d);
      setPhase("list");
    } catch (e) {
      if (e?.name === "AbortError" || ac.signal.aborted) return;
      /* Mismo muro de bot que la descarga: mismo aviso de cookies.txt. El menu
         cierra para no dejar al usuario mirando una lista que no va a llegar. */
      if (e.code === "youtube_bot_check") {
        closeMenu(false);
        onBotCheck(e.message);
        return;
      }
      setError(fetchErr(e, e.message));
      setPhase("error");
    }
  }, [url, closeMenu, onBotCheck]);

  /* Abrir: de la cache si ya se pregunto por este video; si no, se pregunta. */
  useEffect(() => {
    if (!open) return;
    const cached = formatsCache.get(url);
    if (cached) {
      setData(cached);
      setPhase("list");
    } else {
      load();
    }
  }, [open, url, load]);

  /* Una busqueda nueva reemplaza los resultados y desmonta la tarjeta: la clave
     del menu abierto se limpia para no quedar apuntando a algo que ya no
     existe (y no reabrir el menu si la misma clave vuelve). */
  useEffect(() => () => setMenuOpen(key, false), [key, setMenuOpen]);

  /* Coloca el menu fixed junto al boton: 300 de ancho, alineado a su borde
     derecho, tambien en el movil (ahi el boton queda a la derecha de la
     tarjeta, asi que el menu sale pegado a el, como un popover). Si abajo no
     cabe y arriba si, se abre hacia arriba. */
  const place = useCallback(() => {
    const btn = btnRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    /* El boton salio de pantalla (la lista scrolleo): no hay donde anclar. */
    if (r.bottom < 0 || r.top > vh) {
      closeMenu(false);
      return;
    }
    const width = Math.min(300, vw - 16);
    const left = clamp(r.right - width, 8, Math.max(8, vw - width - 8));
    /* La altura NATURAL del menu: sin el tope de la colocacion anterior, que
       si no lo mediria ya recortado (y saldria con tres filas). El estilo se
       devuelve tal cual para que React no se entere. */
    const prevMax = menu.style.maxHeight;
    menu.style.maxHeight = "none";
    const natural = menu.offsetHeight || 0;
    menu.style.maxHeight = prevMax;
    const gap = 6;
    const edge = 8;
    const below = vh - (r.bottom + gap) - edge;
    const above = r.top - gap - edge;
    let top;
    let room;
    if (natural <= below) {
      top = r.bottom + gap;
      room = below;
    } else if (natural <= above || above > below) {
      /* Abajo no cabe: arriba, pegado al boton. Si tampoco cabe entero, la
         lista scrollea dentro del menu. */
      room = above;
      top = r.top - gap - Math.min(natural, above);
    } else {
      top = r.bottom + gap;
      room = below;
    }
    setPos({ top: Math.max(edge, top), left, width, maxH: Math.max(140, room) });
  }, [closeMenu]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    /* Ya montado el menu (aunque sea invisible): se puede medir. Vuelve a
       correr cuando llega la lista, que cambia la altura y puede cambiar si
       conviene abrirlo hacia arriba. */
    place();
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, phase, place]);

  /* Foco al menu al abrir (no al primer item): con la lista todavia cargando
     no hay item al que ir, y asi Escape funciona desde el primer instante. */
  useEffect(() => {
    if (!open) return;
    menuRef.current?.focus();
  }, [open]);

  /* Tocar fuera cierra, pero ARRASTRAR no. Se escucha `click` y no
     `pointerdown`: en el movil, poner el dedo fuera para desplazar la pagina
     empezaba con un pointerdown y el menu se cerraba antes de que el usuario
     llegara a mover nada. `click` solo existe si hubo un toque, no un arrastre.
     El boton se excluye porque su propio click ya alterna. */
  useEffect(() => {
    if (!open) return undefined;
    const onOutside = (e) => {
      if (menuRef.current?.contains(e.target)) return;
      if (btnRef.current?.contains(e.target)) return;
      closeMenu(false);
    };
    document.addEventListener("click", onOutside, true);
    return () => document.removeEventListener("click", onOutside, true);
  }, [open, closeMenu]);

  /* Con el menu abierto la pagina no se desplaza: el menu es fixed bajo el
     boton, y si la pagina se mueve el menu se separa de su boton (o el boton
     sale de pantalla y el menu se cierra solo, que era lo que pasaba al
     arrastrar fuera). Lo que se desplaza es la lista del propio menu. */
  useEffect(() => {
    if (!open) return undefined;
    document.documentElement.classList.add("rsvm-lock");
    return () => document.documentElement.classList.remove("rsvm-lock");
  }, [open]);

  const pick = (height) => {
    closeMenu(true);
    /* Sin `height` = lo mejor disponible, exactamente igual que antes. */
    onDownload(t, height);
  };

  const onMenuKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
      return;
    }
    /* Tab cierra y deja el foco en el boton: el menu es un portal al final del
       <body> y sin esto el tabulado siguiente caeria lejos de la tarjeta. */
    if (e.key === "Tab") {
      e.preventDefault();
      closeMenu(true);
      return;
    }
    const items = Array.from(
      menuRef.current?.querySelectorAll('[role="menuitem"]') || []
    ).filter((el) => !el.disabled);
    if (!items.length) return;
    const cur = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(cur + 1 + items.length) % items.length].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[cur <= 0 ? items.length - 1 : cur - 1].focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1].focus();
    }
  };

  const resolutions = data?.resolutions || [];

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={cx("dl", "dl--split", open && "is-open")}
        disabled={busy}
        onClick={() => (open ? closeMenu(false) : setMenuOpen(key, true))}
        onKeyDown={(e) => {
          /* El patron del boton de menu: bajar abre en vez de mover el foco. */
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setMenuOpen(key, true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={
          downloaded
            ? "Descargado: elige una resolución para volver a bajarlo"
            : "Elige la resolución de la descarga"
        }
        aria-label={
          downloaded
            ? `Descargado: ${title}. Elegir resolución`
            : `Descargar ${title}: elegir resolución`
        }
      >
        <span className="swap" key={busy ? "busy" : downloaded ? "done" : "idle"}>
          {busy ? (
            <CircleNotch size={17} className="spin" />
          ) : downloaded ? (
            <Check size={17} weight="bold" />
          ) : (
            <DownloadSimple size={17} weight="bold" />
          )}
        </span>
        <span className="dl__lbl">Descargar</span>
        {!busy && <CaretDown size={13} weight="bold" className="dl__caret" aria-hidden="true" />}
      </button>

      {open &&
        createPortal(
          <div
            id={menuId}
            ref={menuRef}
            className={cx("rsvm", pos && "is-placed")}
            role="menu"
            aria-label={`Resoluciones de ${title}`}
            tabIndex={-1}
            style={
              pos
                ? { top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH }
                : undefined
            }
            onKeyDown={onMenuKey}
          >
            {phase === "loading" && (
              <p className="rsvm__msg" aria-live="polite">
                <CircleNotch size={15} className="spin" aria-hidden="true" />
                Buscando resoluciones…
              </p>
            )}

            {phase === "error" && (
              <div className="rsvm__err" role="alert">
                <p className="rsvm__msg rsvm__msg--err">
                  <WarningCircle size={15} weight="fill" aria-hidden="true" />
                  {error}
                </p>
                <button
                  type="button"
                  role="menuitem"
                  className="rsvm__item rsvm__item--retry"
                  onClick={load}
                >
                  <ArrowClockwise size={15} aria-hidden="true" />
                  Reintentar
                </button>
              </div>
            )}

            {phase === "list" && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="rsvm__item rsvm__item--best"
                  onClick={() => pick(null)}
                >
                  <span className="rsvm__h">Mejor disponible</span>
                  <span className="rsvm__meta">
                    {resolutions[0] ? (
                      <span>
                        {resolutions[0].label || `${resolutions[0].height}p`}
                        {resolutions[0].fps ? ` · ${resolutions[0].fps} fps` : ""}
                      </span>
                    ) : null}
                    {resolutions[0] ? (
                      <span className="rsvm__size">{fmtApproxSize(resolutions[0].filesize)}</span>
                    ) : null}
                  </span>
                </button>
                {resolutions.length > 0 && <div className="rsvm__sep" role="separator" />}
                <div className="rsvm__list" role="none">
                  {resolutions.map((res) => (
                    <button
                      key={res.height}
                      type="button"
                      role="menuitem"
                      className="rsvm__item"
                      onClick={() => pick(res.height)}
                    >
                      <span className="rsvm__h">
                        {res.label || `${res.height}p`}
                        {res.hdr && <span className="rsvm__hdr">HDR</span>}
                      </span>
                      <span className="rsvm__meta">
                        {res.fps ? (
                          <span className={cx("rsvm__fps", res.fps >= 50 && "rsvm__fps--hi")}>
                            {res.fps} fps
                          </span>
                        ) : null}
                        <span className="rsvm__size">{fmtApproxSize(res.filesize)}</span>
                      </span>
                    </button>
                  ))}
                </div>
                {resolutions.length === 0 && (
                  <p className="rsvm__msg">Este vídeo no ofrece resoluciones sueltas.</p>
                )}
              </>
            )}
          </div>,
          document.body
        )}
    </>
  );
}
