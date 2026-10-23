import { cx } from "../shared/ui.jsx";
import { MODES } from "./navigation.js";
import { NavIcon } from "./navIcons.jsx";

/* Una sola lista para las tres piezas: el orden de MODES manda en el
   indicador deslizante y en las tres etiquetas. */
const ITEMS = [
  { id: "download", label: "Descargar" },
  { id: "listen", label: "Escuchar" },
  { id: "discover", label: "Descubrir" },
];

const indexOf = (mode) => Math.max(0, MODES.indexOf(mode));

export function TabBar({ mode, onMode }) {
  const index = indexOf(mode);
  return (
    <nav className="tabbar" aria-label="Modos">
      {/* La pastilla viaja con transform (spring), no cambia de izquierda a
          izquierda: es lo unico que se mueve al cambiar de modo. */}
      <span className="tabbar__ind" aria-hidden="true" style={{ "--i": index }} />
      {ITEMS.map(({ id, label }) => {
        const active = mode === id;
        return (
          <button
            key={id}
            type="button"
            className="tabbar__btn"
            aria-current={active ? "page" : undefined}
            onClick={() => onMode(id)}
          >
            <NavIcon name={id} filled={active} />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/* Variante de paginas deslizables: barra mucho mas baja, solo puntos y el
   nombre del modo activo. El gesto es el protagonista, no los botones. */
export function SwipeDots({ mode, onMode }) {
  const index = indexOf(mode);
  return (
    <nav className="dots" aria-label="Modos">
      <div className="dots__row">
        {ITEMS.map(({ id, label }) => {
          const active = mode === id;
          return (
            <button
              key={id}
              type="button"
              className="dots__btn"
              aria-label={label}
              aria-current={active ? "page" : undefined}
              onClick={() => onMode(id)}
            >
              <span className="dots__dot" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <span className="dots__name" aria-hidden="true">
        {ITEMS[index].label}
      </span>
    </nav>
  );
}

/* Riel del escritorio. El hueco flexible de abajo de los modos es para las
   listas de reproduccion (todavia no existen): se reserva el sitio sin pintar
   nada, para que la sesion 19 no tenga que mover la estructura. */
export function Rail({ mode, settingsOpen, onMode, onSettings }) {
  /* La barra sigue al modo, no a la pantalla: con Ajustes abierto se queda
     donde estaba. */
  const index = Math.max(
    0,
    ITEMS.findIndex(({ id }) => id === mode)
  );
  return (
    <nav className="rail" aria-label="Modos" style={{ "--i": index }}>
      <span className="rail__bar" aria-hidden="true" />
      {ITEMS.map(({ id, label }) => {
        const active = mode === id;
        return (
          <button
            key={id}
            type="button"
            className={cx("rail__btn", active && "is-on")}
            aria-current={active ? "page" : undefined}
            aria-label={label}
            title={label}
            onClick={() => onMode(id)}
          >
            <NavIcon name={id} filled={active} />
          </button>
        );
      })}
      <span className="rail__sep" aria-hidden="true" />
      <div className="rail__lists" aria-hidden="true" />
      <button
        type="button"
        className={cx("rail__btn", settingsOpen && "is-on")}
        aria-label="Ajustes"
        aria-pressed={settingsOpen}
        title="Ajustes"
        onClick={onSettings}
      >
        <NavIcon name="settings" filled={settingsOpen} />
      </button>
    </nav>
  );
}
