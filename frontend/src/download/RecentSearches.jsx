import { useState } from "react";
import { Icon } from "./icons.jsx";
import { clearRecent, readRecent, rememberRecent } from "./recentSearches.js";

/* ---------------------------------------------------------------------------
   BUSQUEDAS RECIENTES (Buscar en reposo)

   Hasta ocho consultas en localStorage, sin cuenta y sin servidor. Cada chip
   reabre su busqueda con el modo con que se hizo. El almacen puede estar
   bloqueado: recentSearches.js lo guarda igual para la visita y no tira.
   ------------------------------------------------------------------------- */

export default function RecentSearches({ onPick }) {
  const [items, setItems] = useState(() => readRecent());

  const pick = (item) => {
    setItems(rememberRecent(undefined, item.text, item.mode));
    onPick(item.text, item.mode);
  };

  const clear = () => setItems(clearRecent(undefined));

  if (!items.length) return null;
  return (
    <section className="rsch" aria-labelledby="rsch-h">
      <div className="rsch__head">
        <h2 className="sh2" id="rsch-h">Búsquedas recientes</h2>
        <button type="button" className="rsch__clear" onClick={clear}>Borrar historial</button>
      </div>
      <ul className="rsch__list">
        {items.map((item) => (
          <li key={item.text}>
            <button type="button" className="rsch__chip" onClick={() => pick(item)}
              aria-label={`Buscar de nuevo «${item.text}»`}>
              <Icon name="Clock" size="sm" />
              <span>{item.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
