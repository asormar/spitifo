import { useRef } from "react";
import { cx } from "./ui.jsx";
import "./verdict.css";

/* ---------------------------------------------------------------------------
   LA PASTILLA DE VEREDICTO

   La usan Buscar (resultados y ficha) y Escuchar (filas, ficha del archivo,
   Ahora suena y la barra): una sola marca, sus etiquetas y sus tonos. Quien la
   pone decide si hay algo que decir; aqui solo se dibuja.
   ------------------------------------------------------------------------- */

export const V_LABEL = {
  match: "Coincide",
  partial: "Parecido",
  mismatch: "No coincide",
  p30: "Solo 30 s",
  unv: "Sin verificar",
};

export const V_TONE = { match: "ok", partial: "near", mismatch: "bad", p30: "mute", unv: "mute" };

/* Al cambiar (una verificacion, una descarga) se remonta y repite su entrada;
   la primera pintura no se anima. */
export function VerdictPill({ v }) {
  const first = useRef(v);
  return (
    <span key={v} className={`vb vb--${V_TONE[v]}`} data-up={v !== first.current ? "" : undefined}>
      {V_LABEL[v]}
    </span>
  );
}

/* La misma pastilla como boton: abre la ficha del archivo (Ahora suena y la
   barra del escritorio). */
export function VerdictChip({ v, onOpen, className }) {
  return (
    <button
      type="button"
      className={cx("vb", `vb--${V_TONE[v]}`, className)}
      title="Ver la ficha del archivo"
      aria-label={`Ver la ficha del archivo: ${V_LABEL[v]}`}
      onClick={onOpen}
    >
      {V_LABEL[v]}
    </button>
  );
}
