/* Iconos de trazo de Buscar (24 px, linea redondeada), los del prototipo. El
   pausa va relleno. Los de Phosphor que usa el toast de progreso viven en
   icons.jsx, que va en el arranque. */

const D = {
  dl: "M12 5v11M7.5 11.5l4.5 4.5 4.5-4.5",
  check: "m5 12.5 4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6 6 18",
  warn: "M12 4 2.5 20h19zM12 10v4M12 17h.01",
  nodl: "M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0M6 6l12 12",
  hp: "M4 15v-3a8 8 0 0 1 16 0v3M5 14h1.5A1.5 1.5 0 0 1 8 15.5v3A1.5 1.5 0 0 1 6.5 20H5a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 5 14zM19 14h-1.5a1.5 1.5 0 0 0-1.5 1.5v3a1.5 1.5 0 0 0 1.5 1.5H19a1.5 1.5 0 0 0 1.5-1.5v-3A1.5 1.5 0 0 0 19 14z",
  pause: "M7 5h2a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM15 5h2a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  spark: "M12 3c.6 4.5 2.5 6.4 7 7-4.5.6-6.4 2.5-7 7-.6-4.5-2.5-6.4-7-7 4.5-.6 6.4-2.5 7-7z",
  retry: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  caret: "m9 6 6 6-6 6",
};

export default function Ico({ n, size = 20 }) {
  const fill = n === "pause";
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={D[n]} />
    </svg>
  );
}
