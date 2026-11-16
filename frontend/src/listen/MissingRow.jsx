import { cx } from "../shared/ui.jsx";

/* Aparte de rows.jsx: rows.jsx tambien lo usa Buscar y viaja en el arranque;
   esta fila solo la pinta la ficha de un album (chunk de paginas). */

/* Fila de una pista que no esta en la biblioteca. Ocupa la misma caja y las
   mismas columnas que una cancion, pero el titulo no es un boton: no suena, no
   tiene menu y no entra en la cola. Solo abre la ficha del album para bajarla;
   el chunk se adelanta al enfocar o pasar el raton por el boton. */
export default function MissingRow({ num, title, table, onOpen, prefetch }) {
  const number = (
    <span className="srow__n" aria-hidden="true">
      {num}
    </span>
  );
  return (
    <div className={cx("srow", "srow--miss", table && "srow--t", table && `srow--${table}`, "srow--n")}>
      {table && number}
      <div className="srow__main">
        {!table && number}
        <span className="srow__txt">
          <span className="srow__t">{title}</span>
          <span className="srow__miss">No está en tu biblioteca</span>
        </span>
        <button
          type="button"
          className="lbtn srow__miss-dl"
          aria-label={`Descargar ${title}`}
          onClick={(e) => onOpen?.(e.currentTarget)}
          onMouseEnter={prefetch}
          onFocus={prefetch}
        >
          Descargar
        </button>
      </div>
      {table && <span className="srow__v" />}
      {table && <span className="srow__c srow__d" />}
      {table && <span />}
    </div>
  );
}
