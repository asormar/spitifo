import { useCallback, useEffect, useRef, useState } from "react";
import { API, errMsg } from "../shared/api.js";
import { buildSearchParams, warmTopResults } from "./api.js";
import { searchAlbums } from "./albumApi.js";
import { searchArtists } from "./artistApi.js";
import { searchBusy, searchDraft, useSearchDraft } from "./searchDraft.js";
import { parseUrl, planSubmit, searchSig, shouldResync, uniqueResults, urlFor } from "./searchPlan.js";
import { subscribeSearch, takeSearch } from "./searchRequest.js";

/* ---------------------------------------------------------------------------
   LA BUSQUEDA DE DESCARGAS

   Todo lo que pasa entre el texto escrito y la lista de resultados: pedir a la
   API, descartar respuestas viejas, repetir al cambiar de modo, leer y escribir
   la URL (?q= y ?mode=) y atender los pedidos de otras pantallas. Escribir NUNCA
   consulta la red: solo Enter, un ejemplo, un pedido o la URL de arranque.
   ------------------------------------------------------------------------- */

export default function useSearchRun() {
  const [q, setQ] = useSearchDraft();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  /* Los albumes y los artistas van en paralelo y aparte: nunca retrasan a
     las canciones, y un fallo de iTunes no rompe la busqueda principal. */
  const [albums, setAlbums] = useState([]);
  const [artists, setArtists] = useState([]);
  /* El texto que produjo esta lista de artistas: si la busqueda de canciones
     falla, `query` queda en el anterior y no debe compararse con artistas
     nuevos. */
  const [artistQuery, setArtistQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState("all");
  const [mode, setMode] = useState("matched");
  const [searched, setSearched] = useState(false);
  /* Cuantas busquedas se lanzaron: quien muestra avisos de otra cosa (las
     descargas) los retira con cada una. */
  const [runs, setRuns] = useState(0);

  const lastSig = useRef("");
  const searchSeq = useRef(0);
  const searchAbort = useRef(null);
  const albumAbort = useRef(null);
  const artistAbort = useRef(null);
  /* El modo que vale ahora, para las funciones estables (run, el pedido). */
  const modeRef = useRef(mode);
  modeRef.current = mode;

  /* Una sola funcion de busqueda, con el texto y el modo que llegan POR
     PARAMETRO. Asi Enter, los ejemplos, el resync automatico y los pedidos
     comparten exactamente el mismo camino, y no importa que el setState de mode
     todavia no haya pegado cuando se la llama. */
  const run = useCallback(async (text, m = modeRef.current) => {
    const t = text.trim();
    if (!t) return;
    /* Cada busqueda toma un numero. Dos que se solapan (o el resync) vuelven
       en cualquier orden: si la lenta llega despues no puede pisar a la que el
       usuario acaba de pedir, ni la URL, ni disparar una tercera peticion con
       el setQuery de la respuesta vieja. */
    const seq = ++searchSeq.current;
    lastSig.current = searchSig(m, t);
    setLoading(true);
    setErr(null);
    setSearched(true);
    setFilter("all");
    setRuns((n) => n + 1);
    const params = buildSearchParams(t, m);
    /* La busqueda anterior, si sigue en vuelo, se cancela. */
    searchAbort.current?.abort();
    const ac = new AbortController();
    searchAbort.current = ac;
    /* Los albumes solo existen en modo Musica. Se piden aparte y sin esperar:
       las canciones no dependen de iTunes ni de lo que tarde esta respuesta. */
    albumAbort.current?.abort();
    artistAbort.current?.abort();
    setAlbums([]);
    setArtists([]);
    setArtistQuery("");
    if (m === "matched") {
      const aa = new AbortController();
      albumAbort.current = aa;
      searchAlbums(t, aa.signal)
        .then((list) => {
          if (seq === searchSeq.current && !aa.signal.aborted) setAlbums(list);
        })
        .catch(() => {});
      /* El «Mejor resultado» es un extra: se pide aparte y su fallo no toca
         ni las canciones ni el estante de albumes. */
      const ra = new AbortController();
      artistAbort.current = ra;
      searchArtists(t, 3, ra.signal)
        .then((list) => {
          if (seq === searchSeq.current && !ra.signal.aborted) {
            setArtists(list);
            setArtistQuery(t);
          }
        })
        .catch(() => {});
    }
    try {
      const r = await fetch(`${API}/search?${params.toString()}`, { signal: ac.signal });
      const d = await r.json();
      if (!r.ok) throw new Error(errMsg(d, "error de búsqueda"));
      if (seq !== searchSeq.current) return;
      const list = uniqueResults(d.results);
      setResults(list);
      setQuery(t);
      warmTopResults(list);
    } catch (e) {
      if (e.name === "AbortError" || seq !== searchSeq.current) return;
      setErr(e.message);
      setResults([]);
    } finally {
      if (seq === searchSeq.current) setLoading(false);
    }
  }, []);

  /* Enter / "Buscar": pegar un enlace en otro modo lleva a "YouTube", que es
     el unico que lo entiende. run fija la firma, asi que el efecto de cambio de
     modo no repite la peticion. Devuelve si habia algo que buscar. */
  const submit = useCallback(() => {
    const plan = planSubmit({ q: searchDraft.get(), mode: modeRef.current });
    if (!plan) return false;
    if (plan.mode !== modeRef.current) setMode(plan.mode);
    run(plan.text, plan.mode);
    return true;
  }, [run]);

  /* Vuelve a la pantalla de reposo: cancela lo que vuele, borra resultados y
     avisos y quita `q` de la URL. El texto del campo no se toca. */
  const reset = useCallback(() => {
    searchSeq.current += 1;
    searchAbort.current?.abort();
    albumAbort.current?.abort();
    artistAbort.current?.abort();
    lastSig.current = "";
    setLoading(false);
    setResults([]);
    setAlbums([]);
    setArtists([]);
    setArtistQuery("");
    setQuery("");
    setErr(null);
    setFilter("all");
    setSearched(false);
    const qs = urlFor(window.location.search, { mode: modeRef.current, query: "" });
    window.history.replaceState(window.history.state, "", qs || window.location.pathname);
  }, []);

  /* Un solo camino para borrar: el boton X del telefono, Escape en el campo de
     arriba y borrar hasta dejarlo vacio terminan igual, en la pantalla de reposo.
     Se mira el almacen (no `q`): el arranque y los pedidos escriben el texto y
     lanzan la busqueda en el mismo instante. */
  useEffect(() => {
    if (searched && !q && !searchDraft.get()) reset();
  }, [q, searched, reset]);

  /* Cambiar de modo tiene que volver a consultar la API, no solo repintar el
     control. La firma evita el loop y el doble fetch del arranque. */
  useEffect(() => {
    if (shouldResync({ searched, query, mode, lastSig: lastSig.current })) run(query, mode);
  }, [mode, searched, query, run]);

  /* El estado vive en la URL: el link se puede compartir y sobrevive al F5. El
     estado del historial es de useNav (cuantas paginas hay): se conserva. */
  useEffect(() => {
    if (!searched || !query) return;
    const qs = urlFor(window.location.search, { mode, query });
    window.history.replaceState(window.history.state, "", qs || window.location.pathname);
  }, [mode, query, searched]);

  /* Arranque: si la URL trae consulta, se recupera sola. Usa run para que la
     firma quede puesta y el resync no dispare un segundo fetch. */
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const { q: text, mode: m } = parseUrl(window.location.search);
    setMode(m);
    if (text) {
      setQ(text);
      run(text, m);
    }
  }, [run, setQ]);

  /* Busqueda pedida desde otra pantalla (un genero del mapa, la barra de
     arriba). Va despues del arranque: si ambos traen texto, el pedido es lo
     ultimo que hizo el usuario y gana (run descarta la anterior). */
  useEffect(() => {
    const take = () => {
      const text = takeSearch();
      if (!text) return;
      setQ(text);
      const plan = planSubmit({ q: text, mode: modeRef.current });
      if (plan.mode !== modeRef.current) setMode(plan.mode);
      run(plan.text, plan.mode);
    };
    take();
    return subscribeSearch(take);
  }, [run, setQ]);

  /* La barra de arriba (en escritorio) lee este bit para su "Buscando". */
  useEffect(() => {
    searchBusy.set(loading);
  }, [loading]);
  useEffect(() => () => searchBusy.set(false), []);

  return {
    q, setQ, mode, setMode, query, results, albums, artists, artistQuery, loading, searched, err, filter, setFilter,
    runs, run, submit, reset,
  };
}
