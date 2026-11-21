import { useRef } from "react";
import Sheet, { Popover, SheetBar } from "../shared/Sheet.jsx";
import Ico from "../shared/ico.jsx";
import { usePc } from "../shared/viewport.js";
import { menuKeys } from "./menuKeys.js";
import { resultMenuGroups } from "./resultMenu.js";

/* ---------------------------------------------------------------------------
   MENUS DEL MODO DESCARGAR

   La misma infraestructura que el menu de resoluciones y el de la biblioteca:
   hoja en telefono, popover en escritorio, en la pila de navegacion (así Escape
   y el atras de Android lo cierran) y con el foco de vuelta en el boton. Flechas
   recorren los items, Inicio y Fin saltan a los extremos. Los grupos llevan su
   etiqueta para el lector de pantalla; los que no tienen items no se pintan.
   ------------------------------------------------------------------------- */

export function MenuBody({ groups, title, onPick }) {
  const ref = useRef(null);
  const first = groups.flatMap((g) => g.items).find((it) => !it.disabled)?.kind;

  return (
    <div
      ref={ref}
      className="rm"
      role="menu"
      aria-label={`Opciones de ${title}`}
      tabIndex={-1}
      onKeyDown={(e) => menuKeys(e, ref.current, '[role="menuitem"]:not(:disabled)')}
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
              data-autofocus={it.kind === first ? "" : undefined}
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

/* La misma hoja/popover para cualquier menu en modo Descargar: el de una fila,
   el del album y el del artista. Asi comparten foco, teclado y aspecto. */
export function MenuSurface({ groups, title, anchor, onPick, onClose }) {
  const pc = usePc();
  const body = <MenuBody groups={groups} title={title} onPick={onPick} />;

  if (pc) return <Popover anchor={anchor} onClose={onClose}>{body}</Popover>;
  return (
    <Sheet title={`Opciones de ${title}`} onClose={onClose} anchor={anchor}>
      <SheetBar title={`Opciones de ${title}`} onClose={onClose} />
      {body}
    </Sheet>
  );
}

export default function ResultMenu({ t, fmt, downloaded, anchor, onPick, onClose }) {
  const title = t.title || "sin título";
  const groups = resultMenuGroups(t, { downloaded, fmt });
  return (
    <MenuSurface
      groups={groups}
      title={title}
      anchor={anchor}
      onPick={onPick}
      onClose={onClose}
    />
  );
}
