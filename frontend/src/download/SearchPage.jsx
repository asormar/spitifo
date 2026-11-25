import { lazy, Suspense } from "react";
import PageHost from "../listen/PageHost.jsx";
import useLibraryHits from "./useLibraryHits.js";
import { useNav } from "../app/useNav.js";
import { backLabel } from "../app/crossMode.js";
import { loadArtistChunk } from "./artistChunk.js";
import { Icon } from "../shared/icons.jsx";

/* La pagina apilada de Buscar: Explorar la biblioteca y «Ver las N canciones»
   de lo que se escribio, mas la pagina del artista que abre «Mejor resultado»
   o «Más de <artista>». Esta ultima vive en su propio chunk. */
const ArtistPage = lazy(() => loadArtistChunk().then((m) => ({ default: m.ArtistPage })));

export default function SearchPage({ view, active }) {
  const nav = useNav();
  const results = useLibraryHits(true);
  /* La pagina del artista se busca en la pila: encima puede haber una hoja
     (la de discografia o la ficha de un disco) que no cambia la pagina. */
  const stack = nav.stackOf("search");
  const artist = stack.find((e) => e.type === "itunesartist");
  const origin = view?.origin;
  let content;
  if (artist) {
    content = (
      <Suspense fallback={<div className="apage apage--msg" aria-busy="true"><p className="sr-only">Cargando el artista…</p></div>}>
        <ArtistPage view={artist} active={active} />
      </Suspense>
    );
  } else {
    content = <PageHost view={view} tab="search" active={active} results={results} />;
  }
  /* Un salto real desde otra pestana deja la migaja fija mientras la pagina
     de catalogo este abierta: nombra el destino y devuelve a la pestana de la
     que se salio con su pila intacta. */
  return (
    <>
      {origin && (
        <button type="button" className="crumb" onClick={() => nav.goTo(origin.tab)}>
          <Icon name="CaretLeft" size="sm" />
          {backLabel(origin.label)}
        </button>
      )}
      {content}
    </>
  );
}
