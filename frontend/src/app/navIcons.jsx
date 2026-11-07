/* Iconos de la navegacion. Las cuatro pestanas y las acciones del chrome
   (volver, mas, cola) son trazos propios (24 px, linea redondeada; mas gruesa en
   la activa); Ajustes es el engranaje de shared/icons.jsx, que va en el script
   inicial. */
import { Icon } from "../shared/icons.jsx";

const PATHS = {
  home: <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  library: <path d="M5 4v16M10 4v16M15 4.5l4.5 15" />,
  discover: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m15.5 8.5-2 5-5 2 2-5z" />
    </>
  ),
  /* Acciones del menu lateral, la barra de arriba y la del reproductor. */
  back: <path d="m15 5-7 7 7 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  queue: <path d="M4 6h16M4 12h16M4 18h10" />,
};

export function NavIcon({ name, filled = false, size = 22 }) {
  if (name === "settings") {
    return <Icon name="GearSix" weight={filled ? "fill" : "regular"} size={size} />;
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={filled ? 2.5 : 2.1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
