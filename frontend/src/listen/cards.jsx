import { useState } from "react";
import { keyUrl } from "../shared/api.js";
import { cx } from "../shared/ui.jsx";
import { toneClass, toneVars } from "../shared/cover.js";
import { Icon } from "./icons.jsx";
import { Bars, initial } from "./rows.jsx";

/* ---------------------------------------------------------------------------
   PIEZAS DEL INICIO DE ESCUCHAR

   Portada, mosaico y cabecera de seccion: lo que comparten las tarjetas del
   inicio, los resultados de busqueda y las paginas. La portada es el .jpg que
   el backend deja junto a la pista (`thumbKey`); sin el, o si falla al cargar,
   se dibuja un color de genero con una trama suave y la inicial. El color y la
   trama salen de un tono estable por nombre (shared/cover.js); el CSS lo
   pinta (home.css).
   ------------------------------------------------------------------------- */

/* La primera portada real de un grupo de canciones, o null. */
export const coverOf = (entries) => {
  const hit = entries.find((e) => e.thumbKey);
  return hit ? keyUrl(hit.thumbKey) : null;
};

/* `size` es el lado en px (lo lee el CSS con --s); `round` = artista. */
export function Cover({ tone, label, src, size, round, className, children }) {
  const [bad, setBad] = useState(false);
  return (
    <span
      className={cx("cv", toneClass(tone), round && "cv--round", className)}
      style={{ ...toneVars(tone), ...(size && { "--s": `${size}px` }) }}
    >
      <span aria-hidden="true">{initial(label)}</span>
      {src && !bad && (
        <img
          className="cv__img"
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBad(true)}
        />
      )}
      {children}
    </span>
  );
}

/* La pista que suena sobre una portada: el ecualizador en una pastilla. */
export const NowBadge = ({ on }) => (
  <span className="cv__now">
    <Bars on={on} />
  </span>
);

/* Cuatro tonos en cuadricula 2x2; sin ninguno, una nota sobre fondo neutro. */
export function Mosaic({ tones, className }) {
  if (!tones.length) {
    return (
      <span className={cx("mos mos--empty", className)} aria-hidden="true">
        <Icon name="MusicNote" size={22} />
      </span>
    );
  }
  return (
    <span className={cx("mos", className)} aria-hidden="true">
      {tones.map((t, i) => (
        <span key={i} className={cx("cv", toneClass(t))} style={toneVars(t)} />
      ))}
    </span>
  );
}

/* Titulo de seccion con su "Ver todo". `id` enlaza la seccion con su titulo. */
export function SectionHead({ id, title, onAll, label }) {
  return (
    <div className="hsec__head">
      <h2 id={id} className="hsec__h">
        {title}
      </h2>
      {onAll && (
        <button type="button" className="hsec__all" onClick={onAll} aria-label={label || `Ver todo: ${title}`}>
          Ver todo
          <Icon name="CaretRight" size={14} />
        </button>
      )}
    </div>
  );
}
