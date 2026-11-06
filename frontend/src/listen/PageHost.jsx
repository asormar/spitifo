import { useState } from "react";
import { useListen } from "./ListenProvider.jsx";
import { AllPage, DetailPage, LibraryPage } from "./Pages.jsx";
import { viewKey } from "../app/navigation.js";

/* ---------------------------------------------------------------------------
   PAGINA APILADA

   Pinta la pagina de arriba de la pila de la pestana activa: "Ver todo",
   Explorar la biblioteca (desde "Ver mas" de Buscar) y la ficha de un album, un
   artista o una lista. Lo monta la pantalla duena de la pila (Inicio, Tu
   biblioteca o Buscar) en lugar de su raiz; `results` son los resultados de la busqueda de Tu biblioteca,
   para sus paginas "Ver todo".
   ------------------------------------------------------------------------- */

/* Las paginas de "Ver todo" de resultados solo existen con consulta; sin ella
   (la busqueda ya se cerro) no hay nada que listar. */
const EMPTY_RESULTS = { songs: [], artists: [], albums: [], lists: [] };

export default function PageHost({ view, tab, active, results }) {
  const { ctx, model } = useListen();
  /* Orden de Explorar la biblioteca; Buscar lo pide en "recent". */
  const [sort, setSort] = useState(view.sort ?? "recent");

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
      <LibraryPage key={key} index={model.index} sort={sort} onSort={setSort} active={active} ctx={ctx} />
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
