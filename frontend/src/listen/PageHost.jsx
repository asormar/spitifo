import { useListen } from "./ListenProvider.jsx";
import DetailPage from "./Detail.jsx";
import { AllPage, LibraryPage } from "./Pages.jsx";
import { viewKey } from "../app/navigation.js";
import "../shared/chips.css";
import "./home.css";
import "./pages.css";

/* ---------------------------------------------------------------------------
   PAGINA APILADA

   Pinta la pagina de arriba de la pila de la pestana activa: "Ver todo",
   Todas tus canciones (desde Tu biblioteca, Inicio o "Ver mas" de Buscar) y la
   ficha de un album, un artista o una lista. Lo monta la pantalla duena de la
   pila (Inicio, Tu biblioteca o Buscar) en lugar de su raiz; `results` son los
   resultados de la busqueda de Tu biblioteca, para sus paginas "Ver todo".
   Va en su propio chunk (pageLoader.jsx): el primer arranque no lo carga.
   ------------------------------------------------------------------------- */

/* Las paginas de "Ver todo" de resultados solo existen con consulta; sin ella
   (la busqueda ya se cerro) no hay nada que listar. */
const EMPTY_RESULTS = { songs: [], artists: [], albums: [], lists: [] };

export default function PageHost({ view, tab, active, results }) {
  const { ctx, model } = useListen();

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
    page = <LibraryPage key={key} view={view} index={model.index} storage={model.storage} active={active} ctx={ctx} />;
  } else {
    page = <DetailPage key={key} view={view} storage={model.storage} {...common} />;
  }
  return (
    <section className="listen" aria-label="Biblioteca">
      {page}
    </section>
  );
}
