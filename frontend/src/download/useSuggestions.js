import { useEffect, useRef, useState } from "react";
import { API, errMsg } from "../shared/api.js";
import { searchSuggestions } from "./searchDraft.js";
import { SUGGEST_MS, mergeSuggestions, suggestionKey, suggestTerm } from "./suggestions.js";

/* ---------------------------------------------------------------------------
   SUGERENCIAS MIENTRAS SE ESCRIBE

   Debounce de 160 ms tras la ultima tecla y una sola peticion ligera a iTunes
   (sin YouTube, sin el stream de Buscar). La biblioteca se mezcla en el mismo
   hook, gratis y primero. Cambiar el texto corta la peticion anterior.
   ------------------------------------------------------------------------- */

export default function useSuggestions({ q, library = [], enabled = true }) {
  const [remote, setRemote] = useState([]);
  const [loading, setLoading] = useState(false);
  const term = suggestTerm(q);
  const seq = useRef(0);
  const abort = useRef(null);

  useEffect(() => {
    abort.current?.abort();
    if (!enabled || !term) {
      setRemote([]);
      setLoading(false);
      return undefined;
    }
    const id = setTimeout(async () => {
      const intento = ++seq.current;
      const ac = new AbortController();
      abort.current = ac;
      setLoading(true);
      try {
        const r = await fetch(`${API}/search/suggest?q=${encodeURIComponent(term)}&limit=6`, {
          signal: ac.signal,
        });
        if (!r.ok) throw new Error(errMsg(await r.json().catch(() => ({})), "no se pudieron sugerir"));
        const d = await r.json();
        if (intento === seq.current) setRemote(Array.isArray(d.suggestions) ? d.suggestions : []);
      } catch (e) {
        if (e?.name !== "AbortError" && intento === seq.current) setRemote([]);
      } finally {
        if (intento === seq.current) setLoading(false);
      }
    }, SUGGEST_MS);
    return () => clearTimeout(id);
  }, [term, enabled]);

  useEffect(() => () => abort.current?.abort(), []);

  const suggestions = mergeSuggestions(library, remote);
  /* La barra de arriba (PC) lee el mismo almacen: ahi es donde esta el campo.
     El efecto se dispara solo cuando cambia el contenido, no cada render. */
  const key = suggestions.map(suggestionKey).join("|");
  useEffect(() => {
    searchSuggestions.set(suggestions);
  }, [key, term, enabled]);

  return { suggestions, loading };
}
