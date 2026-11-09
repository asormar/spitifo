/* Iconos de trazo (24 px, linea redondeada), los del prototipo: Buscar, Inicio y
   Tu biblioteca. El pausa va relleno. Tambien los usa el toast de progreso, que
   va en el arranque.
   `ext` sustituye a la flecha de texto: esa no esta en la fuente y obligaba a
   buscar otra en el sistema al abrir la ficha. */

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
  ext: "M7 17 17 7M9 7h8v8",
  stats: "M4 19h16M7 16V9M12 16V5M17 16v-4",
  clock: "M3.5 12a8.5 8.5 0 1 0 17 0 8.5 8.5 0 1 0-17 0M12 7.5V12l3 2",
  music: "M9 18V6l10-2v12M4 18a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0M14 16a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  grip: "M9 7h.01M9 12h.01M9 17h.01M15 7h.01M15 12h.01M15 17h.01",
  pen: "M4 20h4L19 9l-4-4L4 16z",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  next: "M4 6h12M4 12h8M4 18h8M15 14l5 4-5 4z",
  queue: "M4 6h12M4 12h12M4 18h7M17 15v6l4.5-3z",
  addlist: "M4 6h11M4 12h11M4 18h7M18 15v6M15 18h6",
  disc: "M3.5 12a8.5 8.5 0 1 0 17 0 8.5 8.5 0 1 0-17 0M9.5 12a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0",
  user: "M8 8a4 4 0 1 0 8 0 4 4 0 1 0-8 0M4.5 20a7.5 7.5 0 0 1 15 0",
  expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
  collapse: "M20 10h-6V4M4 14h6v6M14 10l7-7M3 21l7-7",
  file: "M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9.5 13h5M9.5 17h5",
  /* Ajustes: los cinco que antes eran Phosphor de 256 y viajaban en su chunk
     (settings/icons.jsx). `trash` ya estaba. */
  device: "M9 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM11 18h2",
  laptop: "M4 6h16v10H4zM2 19h20",
  cloud: "M7.5 18h9a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 7.2 10.5 3.75 3.75 0 0 0 7.5 18z",
  cookie: "M20.5 12.5A8.5 8.5 0 1 1 11.5 3.5a4 4 0 0 0 5 5 4 4 0 0 0 4 4zM9.5 9.5h.01M8.5 14h.01M14 13.5h.01",
  upload: "M12 19V5M7.5 9.5 12 5l4.5 4.5",
};

/* Los puntos son trazos de largo cero: con punta redonda y trazo grueso salen
   como el prototipo. */
const SW = { dots: 3.4, grip: 3 };

export default function Ico({ n, size = 20, sw = SW[n] ?? 2, className }) {
  const fill = n === "pause";
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={D[n]} />
    </svg>
  );
}
