import { useEffect, useRef } from "react";
import Sheet, { Popover } from "../shared/Sheet.jsx";
import Ico from "../shared/ico.jsx";
import { usePc } from "../shared/viewport.js";
import { resultMenuGroups } from "./resultMenu.js";

/* ---------------------------------------------------------------------------
   MENU DE UN RESULTADO DE BUSCAR

   La misma infraestructura que el menu de resoluciones y el de la biblioteca:
   hoja en telefono, popover en escritorio, en la pila de navegacion (así Escape
   y el atras de Android lo cierran) y con el foco de vuelta en el boton. Flechas
   recorren los items, Inicio y Fin saltan a los extremos. Los grupos llevan su
   etiqueta para el lector de pantalla; los que no tienen items no se pintan.
   ------------------------------------------------------------------------- */

const KEYS = { ArrowDown: 1, ArrowUp: -1 };

function Body({ groups, title, onPick }) {
  const ref = useRef(null);
  const onKeyDown = (e) => {
    const items = [...ref.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
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
      aria-label={`Opciones de ${title}`}
      tabIndex={-1}
      data-autofocus=""
      onKeyDown={onKeyDown}
    >
      {groups.map((g) => (
        <div key={g.label} role="group" aria-label={g.label}>
          <p className="rm__g" aria-hidden="true">{g.label}</p>
          {g.items.map((it) => (
            <button
              key={it.kind}
              type="button"
              role="menuitem"
              className="rm__i"
              disabled={it.disabled || undefined}
              onClick={() => onPick(it.kind)}
            >
              <span className="rm__h">
                <Ico n={it.icon} size={18} />
                {it.text}
              </span>
              {it.sub && <span className="rm__d num">{it.sub}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function ResultMenu({ t, query, fmt, downloaded, anchor, onPick, onClose }) {
  const pc = usePc();
  const title = t.title || "sin título";
  const groups = resultMenuGroups(t, { downloaded, fmt });
  const body = <Body groups={groups} title={title} onPick={onPick} />;

  /* El toque no siempre enfoca el boton: al cerrar, el foco vuelve a el. */
  useEffect(
    () => () => {
      if (anchor?.isConnected) anchor.focus({ preventScroll: true });
    },
    [anchor]
  );

  if (pc) return <Popover anchor={anchor} onClose={onClose}>{body}</Popover>;
  return (
    <Sheet title={`Opciones de ${title}`} onClose={onClose} anchor={anchor}>
      <div className="sh__bar">
        <h2 className="sh__bt">{`Opciones de ${title}`}</h2>
        <button type="button" className="cbtn cbtn--sm" aria-label="Cerrar" onClick={onClose}>
          <Ico n="x" size={18} />
        </button>
      </div>
      {body}
    </Sheet>
  );
}
