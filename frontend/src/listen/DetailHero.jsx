import { cx } from "../shared/ui.jsx";
import { toneVars } from "../shared/cover.js";

/* ---------------------------------------------------------------------------
   CABECERA UNICA DE ALBUM, ARTISTA Y LISTA

   Las tres paginas comparten la misma gramatica: portada (cuadrada, o redonda
   para artistas), titulo, linea de datos y la fila de acciones siempre en el
   mismo sitio. "Volver" y el menu de lista flotan en la misma esquina. El tamano
   y el titulo se leen de --hero-h y --hero-title, que el CSS fija por ancho de
   pantalla; el componente no decide medidas.
   ------------------------------------------------------------------------- */

export default function DetailHero({ art, title, meta, by, acts, foot, back, more, round, tone }) {
  return (
    <header
      className={cx("dhero", round && "dhero--round")}
      style={round ? toneVars(tone) : undefined}
    >
      {back && <div className="dhero__back">{back}</div>}
      <div className="dhero__art">{art}</div>
      <div className="dhero__body">
        <div className="dhero__top">
          {title}
          {more && <div className="dhero__more">{more}</div>}
        </div>
        {by && (
          <button type="button" className="dhero__by" aria-label={`Abrir artista ${by.name}`} onClick={by.onClick}>
            {by.name}
          </button>
        )}
        {meta && <p className="dmeta dhero__meta">{meta}</p>}
        {acts}
        {foot}
      </div>
    </header>
  );
}
