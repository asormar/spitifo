/* ---------------------------------------------------------------------------
   SALTOS DE MODO (fase 14)

   Desde una entidad, el contenido que puede vivir en la pestana actual se
   abre en la misma pila: un «atrás» cierra solo esa pagina. El contenido
   ajeno (el catalogo, que solo sabe pintar Buscar) da un salto real a Buscar
   y deja una migaja «Volver a…» con el origen, para que el camino de vuelta
   no se pierda al sustituir la pila.
   ------------------------------------------------------------------------- */

/* Paginas que PageHost puede pintar en Inicio, Tu biblioteca o Buscar. */
const LOCAL_TYPES = new Set(["album", "artist", "list", "all", "library"]);

export function crossTarget(view, origin) {
  if (!view || typeof view.type !== "string") return null;
  if (LOCAL_TYPES.has(view.type)) return { kind: "open", view };
  return { kind: "jump", view: { ...view, origin } };
}

export function crossGo(nav, view, origin) {
  const target = crossTarget(view, origin);
  if (!target) return false;
  /* El catalogo ya vive en Buscar: si estamos alli, se apila como cualquier
     otra pagina en vez de sustituir la pila. */
  if (target.kind === "open" || nav.tab === "search") nav.open(target.view);
  else nav.goTo("search", target.view);
  return true;
}

/* La migaja nombra el destino, no un «Volver» generico. */
export function backLabel(name) {
  return name ? `Volver a ${name}` : "Volver";
}

const TAB_LABELS = { home: "Inicio", search: "Buscar", library: "Tu biblioteca", discover: "Descubrir" };
const SECTION_LABELS = {
  lists: "Tus listas",
  albums: "Álbumes",
  artists: "Artistas",
  recent: "Añadido hace poco",
  top: "Lo que más escuchas",
};
const PAGE_LABELS = { album: "Álbum", artist: "Artista", itunesartist: "Artista", list: "Lista", library: "Tu biblioteca" };

/* A donde lleva un «Volver» desde la entrada de arriba: la pestana bajo
   Ajustes, el titulo de la seccion «Ver todo» o el tipo de la pagina. Las hojas
   no son paginas y no cambian el nombre del destino. */
export function destinationLabel(state) {
  const stack = state?.stack ?? [];
  if (stack[stack.length - 1]?.type === "settings") {
    return TAB_LABELS[state.tab] ?? "la pestaña anterior";
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entry = stack[i];
    if (entry.type === "all") return SECTION_LABELS[entry.what] ?? "la página anterior";
    const base = PAGE_LABELS[entry.type];
    if (base) return entry.name ?? base;
  }
  return null;
}

/* Etiqueta lista para un aria-label, con destino cuando hay uno. */
export function backToLabel(state) {
  return backLabel(destinationLabel(state));
}
