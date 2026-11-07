import PageHost from "../listen/PageHost.jsx";
import useLibraryHits from "./useLibraryHits.js";

/* La pagina apilada de Buscar: Explorar la biblioteca y «Ver las N canciones»
   de lo que se escribio. Esta ultima necesita los resultados, que salen del
   mismo texto que lee «En tu biblioteca». */
export default function SearchPage({ view, active }) {
  const results = useLibraryHits(true);
  return <PageHost view={view} tab="search" active={active} results={results} />;
}
