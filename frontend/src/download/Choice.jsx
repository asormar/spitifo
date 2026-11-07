import { useRef } from "react";
import { cx } from "../shared/ui.jsx";

/* ---------------------------------------------------------------------------
   UNA ELECCION EN CHIPS

   Un solo componente para el modo, el contenido, el formato y el filtro de
   resultados. `kind="radio"` es un radiogroup real (flechas, Home y End con
   roving tabindex: un solo tab stop); `kind="toggle"` son botones con
   aria-pressed (el filtro, que tambien permite "ninguno" fuera del grupo).

   options: [{ id, label, title?, dead?, n? }]. `dead` marca una opcion sin
   deshabilitarla (YouTube apagado: el title explica el 0 de resultados). `n` es
   el contador del filtro. `label` es solo visual: el nombre accesible ya lo lleva
   el grupo (ariaLabel).
   ------------------------------------------------------------------------- */

export default function Choice({ options, value, onChange, ariaLabel, label, kind = "radio" }) {
  const refs = useRef([]);
  const radio = kind === "radio";
  const current = Math.max(
    0,
    options.findIndex((o) => o.id === value)
  );

  const move = (next) => {
    const i = (next + options.length) % options.length;
    onChange(options[i].id);
    refs.current[i]?.focus();
  };

  const onKeyDown = (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const to = step ? current + step : e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : null;
    if (!radio || to === null) return;
    e.preventDefault();
    move(to);
  };

  const chips = (
    <div className="chips" role={radio ? "radiogroup" : "group"} aria-label={ariaLabel}>
      {options.map((o, i) => {
        const on = value === o.id;
        return (
          <button
            key={o.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role={radio ? "radio" : undefined}
            aria-checked={radio ? on : undefined}
            aria-pressed={radio ? undefined : on}
            tabIndex={radio && !on ? -1 : undefined}
            title={o.title}
            className={cx("chip", on && "is-on", o.dead && "is-dead")}
            onClick={() => onChange(o.id)}
            onKeyDown={onKeyDown}
          >
            {o.label}
            {o.n != null && <span className="chip__n">{o.n}</span>}
          </button>
        );
      })}
    </div>
  );

  if (!label) return chips;
  return (
    <div className="cgroup">
      <span className="cgroup__lbl" aria-hidden="true">
        {label}
      </span>
      {chips}
    </div>
  );
}
