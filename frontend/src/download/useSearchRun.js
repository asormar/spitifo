import { useCallback, useEffect, useRef, useState } from "react";
import { API, errMsg, rowKey } from "../shared/api.js";
import { buildSearchParams, prepareTopStreams, warmTopResults } from "./api.js";
import { mergeMatchedTracks, searchAlbums } from "./albumApi.js";
import { searchArtists } from "./artistApi.js";
import { searchBusy, searchDraft, useSearchDraft } from "./searchDraft.js";
import { parseUrl, planSubmit, searchSig, shouldResync, uniqueResults, urlFor } from "./searchPlan.js";
import { subscribeSearch, takeSearch } from "./searchRequest.js";
import { consumeWaves, createWaveQueue, fetchTrackMatch, matchState } from "./searchWaves.js";

/* Los adelantos dedupean por URL: llamarlos por lote no cuesta red de mas. */
const paint = (list) => { warmTopResults(list); prepareTopStreams(list); };

/* ---------------------------------------------------------------------------
   LA BUSQUEDA DE DESCARGAS

   Todo lo que pasa entre el texto escrito y la lista de resultados: pedir a la
   API, descartar respuestas viejas, repetir al cambiar de modo, leer y escribir
   la URL (?q= y ?mode=) y atender los pedidos de otras pantallas. Escribir NUNCA
   consulta la red: solo Enter, un ejemplo, un pedido o la URL de arranque.
   ------------------------------------------------------------------------- */

/* `onRequest` avisa cuando se consume una busqueda pedida desde otra pantalla
   (la barra de arriba, un genero de Descubrir). */
export default function useSearchRun({ onRequest } = {}) {
  const onRequestRef = useRef(onRequest);
  onRequestRef.current = onRequest;
  const [q, setQ] = useSearchDraft();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  /* Que tan bien cubrio iTunes la consulta en modo Musica: none / weak / match.
     Vacio en respuestas viejas o en otros modos: la UI sigue como siempre. */
  const [catalog, setCatalog] = useState("");
  /* Los albumes y los artistas llegan con el catalogo de la ola (o en su
     evento `shelves`, si tardan); un fallo de iTunes los deja vacios sin
     romper la busqueda principal. */
  const [albums, setAlbums] = useState([]);
  const [artists, setArtists] = useState([]);
  /* El texto que produjo esta lista de artistas: si la busqueda de canciones
     falla, `query` queda en el anterior y no debe compararse con artistas
     nuevos. */
  const [artistQuery, setArtistQuery] = useState("");
  /* Estantes de esta busqueda todavia en camino: la pantalla les guarda el
     hueco para que no empujen a las canciones al llegar. */
  const [shelvesPending, setShelvesPending] = useState(false);
  /* La respuesta termino (done, JSON o error). Lo que depende del match de
     todas las filas (el recuento de completas, «ninguno se puede descargar»)
     espera a esto. */
  const [streamDone, setStreamDone] = useState(true);
  /* Que busqueda pinto la lista: la entrada en cascada es una por busqueda,
     no una por lote. */
  const [resultsRun, setResultsRun] = useState(0);
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
  /* La lista y la cola de filas "lazy" viven aca: un cambio de busqueda
     corta los pedidos que quedaron volando. */
  const listRef = useRef(null);
  const waveQueue = useRef(null);
  /* El modo que vale ahora, para las funciones estables (run, el pedido). */
  const modeRef = useRef(mode);
  modeRef.current = mode;

  /* Un lote que llega reemplaza su fila sin moverla. Los dos adelantos
     dedupean por URL, asi que llamarlos por lote no cuesta red de mas. */
  const mergeIntoResults = useCallback((updates) => {
    setResults((prev) => mergeMatchedTracks(prev, updates));
    paint(updates);
  }, []);

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
    const matched = m === "matched";
    lastSig.current = searchSig(m, t);
    setLoading(true);
    setStreamDone(false);
    setErr(null);
    setSearched(true);
    setFilter("all");
    setRuns((n) => n + 1);
    const params = buildSearchParams(t, m);
    /* Solo Musica llega en olas; los otros modos y los servers viejos siguen
       con la respuesta de una sola vez. */
    if (matched) params.set("stream", "1");
    /* La busqueda anterior, si sigue en vuelo, se cancela. */
    searchAbort.current?.abort();
    const ac = new AbortController();
    searchAbort.current = ac;
    albumAbort.current?.abort();
    artistAbort.current?.abort();
    /* Los estantes se reemplazan de una vez, con el texto que los produjo. */
    const setShelves = ({ artists: ar = [], albums: al = [] }, pending = false) => {
      setAlbums(al);
      setArtists(ar);
      setArtistQuery(t);
      setShelvesPending(pending);
    };
    /* En Musica los estantes viejos se quedan (atenuados, como la lista)
       hasta el catalogo nuevo; sin ellos, la pantalla guarda su hueco. Los
       demas modos no tienen estantes. */
    if (matched) setShelvesPending(true);
    else setShelves({});
    /* Server sin estantes en la ola: se piden aparte, como antes, y su fallo
       no toca ni las canciones ni el otro estante. */
    const requestShelves = () => {
      const aa = new AbortController();
      albumAbort.current = aa;
      searchAlbums(t, aa.signal)
        .then((list) => {
          if (seq === searchSeq.current && !aa.signal.aborted) setAlbums(list);
        })
        .catch(() => {});
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
    };
    let gotShelves = false;
    try {
      const r = await fetch(`${API}/search?${params.toString()}`, { signal: ac.signal });
      if (!r.ok) throw new Error(errMsg(await r.json().catch(() => ({})), "error de búsqueda"));
      /* Catalogo de la ola y JSON de siempre pintan igual: el stream solo
         adelanta ese instante y deja que los lotes reemplacen filas. */
      /* Con el catalogo en pantalla la lista deja de estar vieja: las filas
         que siguen buscando lo dicen ellas, no la lista entera. */
      const show = (list, ev) => {
        setLoading(false);
        setResults(list);
        setResultsRun(seq);
        setCatalog(ev.catalog || "");
        setQuery(t);
        paint(list);
      };
      const streamed = await consumeWaves(r, {
        /* Estantes y canciones en el mismo pintado. Si los estantes tardan,
           los viejos se van con la lista vieja y el hueco espera a `shelves`. */
        onCatalog: (list, ev, shelves) => {
          if (seq !== searchSeq.current) return;
          gotShelves = Boolean(shelves);
          if (matched) setShelves(shelves || {}, !shelves);
          show(list, ev);
        },
        onShelves: (shelves) => {
          if (seq !== searchSeq.current) return;
          gotShelves = true;
          setShelves(shelves);
        },
        onTracks: (tracks) => {
          if (seq !== searchSeq.current) return;
          mergeIntoResults(tracks);
        },
      });
      /* El evento done es la ultima linea: al terminar la lectura el finally
         de abajo marca la busqueda como terminada. */
      if (streamed) {
        if (matched && !gotShelves && seq === searchSeq.current) requestShelves();
        return;
      }
      const d = await r.json();
      if (seq !== searchSeq.current) return;
      if (matched) {
        setShelves({});
        requestShelves();
      }
      show(uniqueResults(d.results), d);
    } catch (e) {
      if (e.name === "AbortError" || seq !== searchSeq.current) return;
      setErr(e.message);
      setResults([]);
      setCatalog("");
      setShelves({});
    } finally {
      if (seq === searchSeq.current) {
        setLoading(false);
        setStreamDone(true);
        setShelvesPending(false);
      }
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
    setCatalog("");
    setAlbums([]);
    setArtists([]);
    setArtistQuery("");
    setShelvesPending(false);
    setStreamDone(true);
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
      onRequestRef.current?.();
      setQ(text);
      const plan = planSubmit({ q: text, mode: modeRef.current });
      if (plan.mode !== modeRef.current) setMode(plan.mode);
      run(plan.text, plan.mode);
    };
    take();
    return subscribeSearch(take);
  }, [run, setQ]);

  /* Una cola por busqueda: cambiar de texto, de modo o salir corta los
     pedidos de las filas que todavia esperaban su version completa. */
  useEffect(() => {
    if (mode !== "matched") return;
    const q = createWaveQueue({
      match: fetchTrackMatch,
      onMatched: (full) => mergeIntoResults([full]),
    });
    waveQueue.current = q;
    return () => { q.abort(); waveQueue.current = null; };
  }, [mode, runs, mergeIntoResults]);

  /* Un solo observador para toda la lista. Cada fila "lazy" que entra (con
     200 px de anticipo) pasa a la cola; las demas se ignoran. */
  useEffect(() => {
    const root = listRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        const t = results.find((x) => rowKey(x) === en.target.dataset.k);
        /* La fila no dice nada hasta su match (pasa directo a entera o a
           30 s); la cola la marca como ocupada mientras vuela, asi no se pide
           dos veces aunque vuelva a observarse. */
        if (t && matchState(t) === "lazy") waveQueue.current?.add(t);
      }
    }, { rootMargin: "200px" });
    root.querySelectorAll('[data-wave="lazy"]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [results, runs, mode, filter]);

  /* La barra de arriba (en escritorio) lee este bit para su "Buscando". */
  useEffect(() => {
    searchBusy.set(loading);
  }, [loading]);
  useEffect(() => () => searchBusy.set(false), []);

  return {
    q, setQ, mode, setMode, query, results, catalog, albums, artists, artistQuery, loading, searched, err, filter, setFilter,
    shelvesPending, streamDone, resultsRun, runs, run, submit, reset, listRef,
  };
}
