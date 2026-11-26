import { TABS } from "./navigation.js";
import { Icon } from "../shared/icons.jsx";

/* Nombres de Phosphor para cada pestana (ver DESIGN.md > Navigation). */
const TAB_ICON = { home: "House", search: "MagnifyingGlass", library: "Books", discover: "VinylRecord" };

/* Una sola lista para las piezas de la navegacion (barra, puntos y menu
   lateral): el orden de TABS manda en el indicador y en las etiquetas. */
export const ITEMS = [
  { id: "home", label: "Inicio" },
  { id: "search", label: "Buscar" },
  { id: "library", label: "Tu biblioteca" },
  { id: "discover", label: "Descubrir" },
];

const indexOf = (tab) => TABS.indexOf(tab);

export function TabBar({ tab, onTab }) {
  const found = indexOf(tab);
  const index = Math.max(0, found);
  return (
    <nav className="tabbar" aria-label="Modos">
      {/* La pastilla del icono viaja con transform: es lo unico que se mueve al
          cambiar de pestana. Con Ajustes abierta no hay pestana activa. */}
      {found >= 0 && <span className="tabbar__ind" aria-hidden="true" style={{ "--i": index }} />}
      {ITEMS.map(({ id, label }) => {
        const active = tab === id;
        return (
          <button
            key={id}
            type="button"
            className="tabbar__btn"
            aria-current={active ? "page" : undefined}
            onClick={() => onTab(id)}
          >
            <Icon name={TAB_ICON[id]} weight={active ? "fill" : "regular"} size="lg" />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/* Variante de paginas deslizables: puntos con las cuatro etiquetas SIEMPRE
   visibles (micro, el mismo tipo que la barra), no solo la de la pestana
   activa. El objetivo de toque de cada punto es de 48 px. */
export function SwipeDots({ tab, onTab }) {
  return (
    <nav className="dots" aria-label="Modos">
      {ITEMS.map(({ id, label }) => {
        const active = tab === id;
        return (
          <span key={id} className="dots__item">
            <button
              type="button"
              className="dots__btn"
              aria-label={label}
              aria-current={active ? "page" : undefined}
              onClick={() => onTab(id)}
            >
              <span className="dots__dot" aria-hidden="true" />
            </button>
            <span className="dots__name" aria-hidden="true">{label}</span>
          </span>
        );
      })}
    </nav>
  );
}
