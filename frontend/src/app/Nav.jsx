import { Suspense, lazy, useSyncExternalStore } from "react";
import { cx } from "../shared/ui.jsx";
import { TABS } from "./navigation.js";
import { NavIcon } from "./navIcons.jsx";

/* Una sola lista para las tres piezas: el orden de TABS manda en el
   indicador deslizante y en las etiquetas. */
const ITEMS = [
  { id: "home", label: "Inicio" },
  { id: "search", label: "Buscar" },
  { id: "library", label: "Tu biblioteca" },
  { id: "discover", label: "Descubrir" },
];

const indexOf = (tab) => Math.max(0, TABS.indexOf(tab));

/* La lista de listas del riel se carga aparte (pide /api/playlists) y solo
   donde hay riel: en telefono no se monta ni se descarga. */
const RailLists = lazy(() => import("../listen/RailLists.jsx"));
const DESKTOP = "(min-width: 720px)";
const watchDesktop = (cb) => {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const isDesktop = () => window.matchMedia(DESKTOP).matches;

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

/* Riel del escritorio. El hueco flexible de abajo de las pestanas es para las
   listas de reproduccion: scrollea si hay muchas. */
export function Rail({ tab, settingsOpen, onTab, onSettings, onPlaylist }) {
  const desktop = useSyncExternalStore(watchDesktop, isDesktop);
  /* La barra sigue a la pestana, no a la pantalla: con Ajustes abierto se
     queda donde estaba. */
  const index = indexOf(tab);
  return (
    <nav className="rail" aria-label="Modos" style={{ "--i": index }}>
      <span className="rail__bar" aria-hidden="true" />
      {ITEMS.map(({ id, label }) => {
        const active = tab === id;
        return (
          <button
            key={id}
            type="button"
            className={cx("rail__btn", active && "is-on")}
            aria-current={active ? "page" : undefined}
            aria-label={label}
            title={label}
            onClick={() => onTab(id)}
          >
            <NavIcon name={id} filled={active} />
          </button>
        );
      })}
      <span className="rail__sep" aria-hidden="true" />
      <div className="rail__lists" role="group" aria-label="Listas">
        {desktop && (
          <Suspense fallback={null}>
            <RailLists onOpen={onPlaylist} />
          </Suspense>
        )}
      </div>
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
