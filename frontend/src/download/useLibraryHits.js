import { useDeferredValue, useMemo } from "react";
import { searchSongs } from "../listen/home.js";
import { useListen } from "../listen/ListenProvider.jsx";
import { useSearchDraft } from "./searchDraft.js";
import { libraryQuery } from "./searchPlan.js";

/* Las canciones de tu biblioteca que casan con lo que se escribe, en vivo y sin
   red: la busqueda es en memoria (home.searchSongs, solo canciones) y escribir
   no espera a que se filtre y se pinte (useDeferredValue). null = menos de 2
   letras o desactivada. */
export default function useLibraryHits(enabled = true) {
  const [q] = useSearchDraft();
  const dq = useDeferredValue(q);
  const { model } = useListen();
  const term = enabled ? libraryQuery(dq) : null;
  return useMemo(
    () => (term ? { songs: searchSongs(model.index, term, model.plays) } : null),
    [term, model.index, model.plays]
  );
}
