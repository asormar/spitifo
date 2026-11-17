import { lazy, Suspense } from "react";
import PageHost from "../listen/PageHost.jsx";
import useLibraryHits from "./useLibraryHits.js";
import { useNav } from "../app/useNav.js";
import { loadArtistChunk } from "./artistChunk.js";

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
  if (artist) {
    return (
      <Suspense fallback={<div className="apage apage--msg" aria-busy="true"><p className="sr-only">Cargando el artista…</p></div>}>
        <ArtistPage view={artist} active={active} />
      </Suspense>
    );
  }
  return <PageHost view={view} tab="search" active={active} results={results} />;
}
