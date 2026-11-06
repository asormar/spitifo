import { useEffect, useRef, useState } from "react";
import { useListen } from "./ListenProvider.jsx";
import { AllPage, DetailPage, LibraryPage } from "./Pages.jsx";
import { sortEntries } from "./home.js";
import { viewKey } from "../app/navigation.js";

/* ---------------------------------------------------------------------------
   PAGINA APILADA

   Pinta la pagina de arriba de la pila de la pestana activa: "Ver todo",
   Explorar la biblioteca y la ficha de un album, un artista o una lista. Lo
   monta la pantalla duena de la pila (Inicio, Tu biblioteca o Buscar) en lugar
   de su raiz; `results` son los resultados de la busqueda de Tu biblioteca,
   para sus paginas "Ver todo".
   ------------------------------------------------------------------------- */

/* Las paginas de "Ver todo" de resultados solo existen con consulta; sin ella
   (la busqueda ya se cerro) no hay nada que listar. */
const EMPTY_RESULTS = { songs: [], artists: [], albums: [], lists: [] };

export default function PageHost({ view, tab, active, results }) {
  const { ctx, model } = useListen();
  const libRef = useRef(null);
  /* Orden de Explorar la biblioteca; Buscar lo pide en "recent". */
  const [sort, setSort] = useState(view.sort ?? "recent");

  /* "Ver en tu biblioteca": con la lista ya pintada, la fila pedida se centra.
     Se espera un momento: si la peticion llego al cerrar "Ahora suena" (un
     atras del historial), el navegador restaura despues el scroll de la
     entrada y pisaria este. */
  const wanted = view.type === "library" ? view.wanted : undefined;
  useEffect(() => {
    if (wanted == null) return undefined;
    const i = sortEntries(model.index.entries, sort).findIndex((e) => e.key === wanted);
    if (i < 0) return undefined;
    const id = setTimeout(() => libRef.current?.scrollToIndex(i), 120);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const key = viewKey(tab, [view]);
  const common = {
    index: model.index,
    byKey: model.byKey,
    lists: model.lists,
    listsReady: model.listsReady,
    active,
    ctx,
  };

  let page;
  if (view.type === "all") {
    page = <AllPage key={key} view={view} r={results || EMPTY_RESULTS} {...common} />;
  } else if (view.type === "library") {
    page = (
      <LibraryPage key={key} ref={libRef} index={model.index} sort={sort} onSort={setSort} active={active} ctx={ctx} />
    );
  } else {
    page = <DetailPage key={key} view={view} {...common} />;
  }
  return (
    <section className="listen" aria-label="Biblioteca">
      {page}
    </section>
  );
}
