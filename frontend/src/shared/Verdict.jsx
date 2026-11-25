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
  p30: "Avance de 30 s",
  unv: "Sin verificar",
};

/* La explicacion de cada veredicto: una sola, compartida por la pastilla (aqui
   solo la etiqueta) y la ficha (verdict.js, fileText.js). */
export const V_EXPLAIN = {
  match: "El audio es la canción que buscaste.",
  partial: "Se parece a lo que buscaste, pero no es exacto.",
  mismatch: "No es la canción que buscaste.",
  p30: "Solo hay 30 s de esta fuente.",
  unv: "Todavía no se ha comprobado el audio.",
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
