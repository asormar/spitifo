import { useState } from "react";
import Ico from "../shared/ico.jsx";
import { cx } from "../shared/ui.jsx";
import { useSaveTarget } from "./saveSong.js";
import "./saveHeart.css";

/* ---------------------------------------------------------------------------
   CORAZON DE GUARDAR

   El mismo boton en una fila de Buscar y en "Ahora suena". Solo mira el estado
   que le da useSaveTarget: el relleno dice si ya esta en la biblioteca y el
   nombre accesible dice que hace el toque. El aviso y el deshacer viven del
   ListenProvider, no aqui.
   ------------------------------------------------------------------------- */

export default function SaveHeart({ t, track, query = "", size = 20, className }) {
  const [pop, setPop] = useState(false);
  const { show, filled, title, toggle } = useSaveTarget({ t, track, query });
  if (!show) return null;
  const label = filled
    ? `Quitar «${title}» de tu biblioteca`
    : `Guardar «${title}» en tu biblioteca`;

  return (
    <button
      type="button"
      className={cx("shrt", filled && "is-on", pop && "is-pop", className)}
      aria-pressed={filled}
      aria-label={label}
      title={label}
      onClick={() => {
        setPop(true);
        toggle();
      }}
      onAnimationEnd={() => setPop(false)}
    >
      <Ico n={filled ? "heart-fill" : "heart"} size={size} />
    </button>
  );
}
