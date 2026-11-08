import { TABS } from "./navigation.js";
import { NavIcon } from "./navIcons.jsx";

/* Una sola lista para las piezas de la navegacion (barra, puntos y menu
   lateral): el orden de TABS manda en el indicador y en las etiquetas. */
export const ITEMS = [
  { id: "home", label: "Inicio" },
  { id: "search", label: "Buscar" },
  { id: "library", label: "Tu biblioteca" },
  { id: "discover", label: "Descubrir" },
];

const indexOf = (tab) => Math.max(0, TABS.indexOf(tab));

export function TabBar({ tab, onTab }) {
  const index = indexOf(tab);
  return (
    <nav className="tabbar" aria-label="Modos">
      {/* La pastilla del icono viaja con transform: es lo unico que se mueve al
          cambiar de pestana. */}
      <span className="tabbar__ind" aria-hidden="true" style={{ "--i": index }} />
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
            <NavIcon name={id} filled={active} size={24} />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/* Variante de paginas deslizables: barra mucho mas baja, dos puntos, el nombre
   de la pestana activa y dos puntos. El gesto es el protagonista. */
export function SwipeDots({ tab, onTab }) {
  const index = indexOf(tab);
  const dot = ({ id, label }) => {
    const active = tab === id;
    return (
      <button
        key={id}
        type="button"
        className="dots__btn"
        aria-label={label}
        aria-current={active ? "page" : undefined}
        onClick={() => onTab(id)}
      >
        <span className="dots__dot" aria-hidden="true" />
      </button>
    );
  };
  return (
    <nav className="dots" aria-label="Modos">
      {ITEMS.slice(0, 2).map(dot)}
      <span className="dots__name" aria-hidden="true">
        {ITEMS[index].label}
      </span>
      {ITEMS.slice(2).map(dot)}
    </nav>
  );
}
