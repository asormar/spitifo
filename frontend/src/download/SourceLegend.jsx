import { useState } from "react";
import { Icon } from "./icons.jsx";
import { sourceLegend } from "./resultTypes.js";

/* ---------------------------------------------------------------------------
   LEYENDA DE FUENTES (Decisión 3)

   La fila se queda con la sigla de 11 px; un boton siempre visible junto a los
   chips abre las cinco equivalencias de una vez. Se aprende una sola vez por
   sesion y no pesa en ninguna fila.
   ------------------------------------------------------------------------- */

export default function SourceLegend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="legend">
      <button
        type="button"
        className="legend__btn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="Info" size="sm" />
        Fuentes
      </button>
      {open && (
        <div className="legend__pop" role="dialog" aria-label="Qué significa cada sigla">
          {sourceLegend().map((s) => (
            <p key={s.code} className="legend__row">
              <b>{s.code}</b> {s.label}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
