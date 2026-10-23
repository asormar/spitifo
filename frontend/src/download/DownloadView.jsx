import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, MagnifyingGlass, Sparkle, WarningCircle, Waveform } from "@phosphor-icons/react";
import { API, errMsg, fetchErr, rowKey } from "../shared/api.js";
import { fmtSize } from "../shared/format.js";
import { cx } from "../shared/ui.jsx";
import {
  EXAMPLES,
  JOB_DISMISS_MS,
  MODE_IDS,
  ORIGINAL_HINT,
  ORIGINAL_HINT_YT,
  PLACEHOLDER,
  isYouTubeUrl,
  trackState,
} from "./constants.js";
import { buildSearchParams, isTerminal, mismatchNotice, pollJob } from "./api.js";
import { ProgressStack } from "./progress.jsx";
import { FilterSegs, FmtPicker, MediaPicker, ModePicker } from "./pickers.jsx";
import { ShowGroup, SkeletonRow, Track } from "./cards.jsx";
import { subscribeSearch, takeSearch } from "./searchRequest.js";

export default function DownloadView({ health, onLibraryChanged, onImportCookies, librarySlot }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  /* El ultimo fallo fue el muro de verificacion de YouTube: el aviso ofrece
     importar cookies.txt y abre esa seccion de la configuracion. */
  const [botCheck, setBotCheck] = useState(false);
  const [done, setDone] = useState(null);
  const [fmt, setFmt] = useState("mp3");
  /* Qué partes se bajan en modo YouTube. Vive acá y no en el selector para que
     cambiar de modo y volver no lo reinicie (como fmt). */
  const [media, setMedia] = useState("audio");
  /* Clave del resultado cuyo menú de resoluciones está abierto. Vive acá y no
     en cada tarjeta para que abrir uno cierre el anterior: un menú a la vez. */
  const [menuKey, setMenuKey] = useState(null);
  const [filter, setFilter] = useState("all");
  /* `busyId` era un unico string: con dos descargas en curso la segunda
     escribia su clave encima de la primera, y el setBusyId(null) del finally
     de la una apagaba el spinner de la otra. Ahora es un Set con TODAS las
     claves en curso: cada fila enciende y apaga su spinner sin tocar el de
     las demas. */
  const [busyIds, setBusyIds] = useState(() => new Set());
  /* Claves de lo que ya se bajo en esta sesion: la tarjeta lo marca con un
     check (sigue siendo pulsable para volver a descargar). */
  const [downloadedIds, setDownloadedIds] = useState(() => new Set());
  /* Un solo `job` tambien se pisaba entre descargas simultaneas. Ahora es un
     mapa clave -> job, y ProgressBar dibuja uno por descarga en curso. */
  const [jobs, setJobs] = useState({});
  const [mode, setMode] = useState("matched");
  const [searched, setSearched] = useState(false);
  /* La lupa orbita mientras busca. Al llegar la respuesta NO se corta: sigue
     hasta cerrar la vuelta en curso (la orbita empieza y acaba en reposo), asi
     que se detiene sin saltar. El timeout es la red de seguridad para
     prefers-reduced-motion, donde no hay animacion ni evento que esperar. */
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    if (loading) {
      setScanning(true);
      return undefined;
    }
    const id = setTimeout(() => setScanning(false), 1500);
    return () => clearTimeout(id);
  }, [loading]);

  const inputRef = useRef();
  const lastSig = useRef("");
  const searchSeq = useRef(0);
  const searchAbort = useRef(null);
  /* Aviso (error o exito) visible en cada momento: se usa para traerlo a
     pantalla si una descarga lejana lo deja fuera de vista. */
  const msgRef = useRef(null);
  /* Foco tras pulsar un ejemplo: el boton se desmonta al buscar y el foco caia
     al <body>. `focusPending` lo marca runExample; `resultsRef` es la cabecera
     de resultados (o el bloque de "sin resultados"). */
  const focusPending = useRef(false);
  const resultsRef = useRef(null);

  /* Un job terminal (done/error/timeout/gone) se retira solo a los 5 s. Con
     varias descargas en curso cada uno tiene su propio temporizador: el de la
     primera no puede borrar el toast de la segunda, que es justo lo que
     pasaba antes. */
  const dismissTimers = useRef(new Map());
  useEffect(() => {
    /* Un temporizador POR job, creado una sola vez cuando el job pasa a
       terminal. Antes habia uno global que se reiniciaba en cada cambio de
       `jobs`: con otra descarga todavia sondeando (un tick cada 700 ms) el
       toast ya terminado no se retiraba nunca, y el CSS de salida (que cuenta
       los mismos 5 s) lo dejaba invisible pero ocupando su hueco en la pila. */
    Object.entries(jobs).forEach(([k, j]) => {
      if (!isTerminal(j) || dismissTimers.current.has(k)) return;
      dismissTimers.current.set(
        k,
        setTimeout(() => {
          dismissTimers.current.delete(k);
          setJobs((cur) => {
            /* Si la misma cancion se volvio a bajar en estos 5 s, el job ya no
               es terminal y NO se toca: no se le retira una descarga viva. */
            if (!isTerminal(cur[k])) return cur;
            const next = { ...cur };
            delete next[k];
            return next;
          });
        }, JOB_DISMISS_MS)
      );
    });
  }, [jobs]);

  useEffect(() => {
    const timers = dismissTimers.current;
    return () => timers.forEach((id) => clearTimeout(id));
  }, []);

  /* Actualiza UN job sin tocar los demas. El setJob viejo pisaba el estado
     entero en cada tick del polling. */
  const setJobFor = useCallback((key, patch) => {
    setJobs((cur) => ({ ...cur, [key]: { ...cur[key], ...patch, key } }));
  }, []);

  /* Abrir/cerrar el menú de resoluciones por clave. Cerrar una clave que ya no
     es la abierta no pisa a la que sí lo está (dos tarjetas no se pelean). */
  const setMenuOpen = useCallback((key, open) => {
    setMenuKey((cur) => (open ? key : cur === key ? null : cur));
  }, []);

  /* El muro de verificación de YouTube desde el menú de resoluciones: mismo
     aviso y misma salida que una descarga (importar cookies.txt). */
  const onBotCheck = useCallback((msg) => {
    setErr(msg);
    setBotCheck(true);
  }, []);

  /* La franja de exito/aviso (.msg) NO se retiraba nunca: se quedaba en
     pantalla hasta que otra accion la limpiara, mientras el toast de progreso
     si se va solo a los 5 s. Se usa el mismo temporizador.

     NO se retira el aviso de ERROR ni el de "esto no es lo que buscabas": esos
     son informacion que el usuario necesita leer, y desaparecen al buscar de
     nuevo o al descargar otra cosa (setDone(null) / setErr(null) en
     onDownload). */
  useEffect(() => {
    if (!done || done.warning) return undefined;
    const id = setTimeout(() => setDone(null), JOB_DISMISS_MS);
    return () => clearTimeout(id);
  }, [done]);

  /* Un fallo/exito de descarga desde una tarjeta lejana pintaba el aviso bajo
     el hero, fuera de vista. Solo se hace scroll si de verdad esta fuera. */
  useEffect(() => {
    if (!err && !done) return;
    const el = msgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    /* 72 px: la barra sticky tapa la parte de arriba. */
    if (r.top >= 72 && r.bottom <= window.innerHeight) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [err, done]);

  /* "/" lleva el foco al buscador salvo que ya se este escribiendo en algo. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const a = document.activeElement;
      if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* Una sola funcion de busqueda, con el texto y el modo que llegan POR
     PARAMETRO. Asi el form, los ejemplos de la pantalla vacia y el resync
     automatico comparten exactamente el mismo camino, y no importa que el
     setState de mode todavia no haya pegado cuando se la llama. */
  const runSearch = useCallback(async (text, m) => {
    const t = text.trim();
    if (!t) return;
    /* Cada busqueda toma un numero. Dos overlapping (o el resync)(devuelven
       en cualquier orden: si la lenta llega despues no puede pisar a la que
       el usuario acaba de pedir, ni la URL, ni disparar una tercera peticion
       con el setQuery de la respuesta vieja. */
    const seq = ++searchSeq.current;
    lastSig.current = `${m}|${t}`;
    setLoading(true);
    setErr(null);
    setDone(null);
    setSearched(true);
    setFilter("all");
    const params = buildSearchParams(t, m);
    /* La busqueda anterior, si sigue en vuelo, se cancela. */
    searchAbort.current?.abort();
    const ac = new AbortController();
    searchAbort.current = ac;
    try {
      const r = await fetch(`${API}/search?${params.toString()}`, { signal: ac.signal });
      const d = await r.json();
      if (!r.ok) throw new Error(errMsg(d, "error de búsqueda"));
      if (seq !== searchSeq.current) return;
      setResults(d.results || []);
      setQuery(t);
    } catch (e) {
      if (e.name === "AbortError" || seq !== searchSeq.current) return;
      setErr(e.message);
      setResults([]);
    } finally {
      if (seq === searchSeq.current) setLoading(false);
    }
  }, []);

  const doSearch = useCallback(
    (e) => {
      e?.preventDefault();
      /* Una busqueda manual no debe heredar un foco pendiente de un ejemplo. */
      focusPending.current = false;
      /* Pegar un enlace en otro modo lleva a "YouTube": es el unico que
         lo entiende. runSearch fija la firma, asi que el efecto de cambio de
         modo no repite la peticion. */
      const m = isYouTubeUrl(q) ? "ytdlp" : mode;
      if (m !== mode) setMode(m);
      runSearch(q, m);
      /* En movil se baja el teclado para ver los resultados. */
      if (window.matchMedia("(pointer: coarse)").matches) inputRef.current?.blur();
    },
    [q, mode, runSearch]
  );

  const runExample = useCallback(
    (text) => {
      setQ(text);
      focusPending.current = true;
      runSearch(text, mode);
    },
    [mode, runSearch]
  );

  /* Se espera a que la busqueda termine: antes no hay nada donde poner el
     foco. Va a la cabecera de resultados (o al aviso de error / sin
     resultados), nunca al input, que abriria el teclado en movil. */
  useEffect(() => {
    if (!focusPending.current || loading || !searched) return;
    focusPending.current = false;
    (resultsRef.current || msgRef.current)?.focus();
  }, [loading, searched, results, err]);

  /* Cambiar de modo tiene que volver a consultar la API, no solo repintar el
     control. La firma evita el loop: si la peticion que corresponde al modo
     actual ya se ejecuto, no se repite. Tambien evita el doble fetch del
     arranque, que setea la misma firma. */
  useEffect(() => {
    if (!searched || !query) return;
    const sig = `${mode}|${query}`;
    if (sig === lastSig.current) return;
    runSearch(query, mode);
  }, [mode, searched, query, runSearch]);

  const onDownload = useCallback(
    async (t, height) => {
      /* Todo el estado de ESTA descarga queda bajo su clave. Con dos a la vez
         cada una enciende su spinner, tiene su toast y anuncia su resultado
         sin pisar a la otra. `err`/`done` siguen siendo globales a proposito:
         son el ultimo mensaje de la pantalla, no uno por fila. */
      const key = rowKey(t);
      const markDownloaded = () => setDownloadedIds((cur) => new Set(cur).add(key));
      setBusyIds((cur) => new Set(cur).add(key));
      setErr(null);
      setDone(null);
      setBotCheck(false);
      try {
        let track = { ...t };
        delete track.downloadable;
        // Las pistas del setlist ya vienen resueltas por /api/setlist.
        // En modo "matched" el video de YouTube ya viene en webpage_url:
        // no hay nada que resolver, la descarga va directo a yt-dlp.
        const isMatched = t.source === "itunes" && t.extra?.webpage_url;
        if (
          !track.audio_url &&
          !isMatched &&
          t.source !== "ytdlp" &&
          t.extra?.needs_resolve
        ) {
          const rr = await fetch(
            `${API}/resolve?query=${encodeURIComponent(query)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(track),
            }
          );
          if (!rr.ok) {
            const d = await rr.json();
            throw new Error(errMsg(d, "no se pudo resolver"));
          }
          track = await rr.json();
          delete track.downloadable;
        }
        // /api/setlist devuelve el veredicto en la raiz, /api/resolve en extra
        const vmatch = t.match || track.extra?.match || track.match;
        const vtitle = t.real_title || track.extra?.real_title || track.real_title;
        const rd = await fetch(
          `${API}/download?query=${encodeURIComponent(query)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              source: track.source,
              track,
              fmt,
              /* Solo el modo YouTube sabe bajar video. En el resto el cuerpo
                 queda exactamente como estaba. */
              ...(mode === "ytdlp" ? { media } : {}),
              /* Altura elegida en el menú. Solo viaja cuando se baja vídeo: en
                 audio el backend no la espera (y "Mejor disponible" = omitirla). */
              ...(mode === "ytdlp" && media !== "audio" && Number.isInteger(height)
                ? { height }
                : {}),
            }),
          }
        );
        const j = await rd.json();
        if (!rd.ok) {
          if (j.code === "youtube_bot_check") setBotCheck(true);
          throw new Error(errMsg(j, "falló la descarga"));
        }

        // yt-dlp devuelve job_id: la descarga corre en background, hacer polling
        if (j.job_id) {
          setJobFor(key, { status: "pending", progress: 0, title: t.title });
          const finished = await pollJob(j.job_id, setJobFor, key, t.title);
          if (finished?.status === "timeout" || finished?.status === "gone") {
            setErr(
              finished.error
                || "Esta descarga sigue corriendo en el servidor y va a aparecer en tu biblioteca cuando termine."
            );
          } else if (finished) {
            if (finished.status === "error") {
              if (finished.error_code === "youtube_bot_check") setBotCheck(true);
              setErr(finished.error || "la descarga falló");
            } else {
              // El veredicto lo publica el backend DENTRO del job (lo calcula
              // en download contra el titulo real del video). Antes este
              // camino hacia `return` y el `match` nunca llegaba a la UI.
              const d = {
                ...j,
                ...finished,
                filename: finished.filename || finished.key,
                size_mb: finished.size_mb,
                match: finished.match || j.match,
                real_title: finished.real_title || j.real_title,
              };
              setDone(
                mismatchNotice(d, d.match || vmatch, d.real_title || vtitle, query)
              );
              markDownloaded();
              onLibraryChanged();
            }
          }
          return;
        }

        setDone(mismatchNotice(j, j.match || vmatch, j.real_title || vtitle, query));
        markDownloaded();
        onLibraryChanged();
      } catch (e) {
        setErr(fetchErr(e, e.message));
      } finally {
        /* Solo se saca ESTA clave del Set: antes `setBusyId(null)` apagaba el
           spinner de la descarga que siguiera corriendo. */
        setBusyIds((cur) => {
          const next = new Set(cur);
          next.delete(key);
          return next;
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fmt, media, mode, query, setQuery, setJobFor]
  );

  /* El estado vive en la URL: el link se puede compartir y sobrevive al F5.
     Se parte de la busqueda actual y solo se tocan `mode` y `q`: `view` (el
     modo del shell) y cualquier otro parametro siguen donde estaban. */
  const writeUrl = useCallback((m, text) => {
    const p = new URLSearchParams(window.location.search);
    if (m) p.set("mode", m);
    else p.delete("mode");
    if (text) p.set("q", text);
    else p.delete("q");
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, []);

  useEffect(() => {
    if (!searched) return;
    writeUrl(mode, query);
  }, [mode, query, searched, writeUrl]);

  /* Arranque: si la URL trae consulta, se recupera sola. Usa runSearch para
     que la firma quede seteada y el resync no dispare un segundo fetch.
     Los links viejos con ?src=ytdlp equivalen al modo YouTube; cualquier
     otra fuente ya no se puede filtrar porque los chips se fueron. */
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const p = new URLSearchParams(window.location.search);
    const m = p.get("mode");
    const text = p.get("q");
    const mm = m && MODE_IDS.includes(m) ? m : p.get("src") === "ytdlp" ? "ytdlp" : "matched";
    setMode(mm);
    if (text) {
      setQ(text);
      runSearch(text, mm);
    }
  }, [runSearch]);

  /* Busqueda pedida desde otra pantalla (p. ej. un genero del mapa). Va despues
     del arranque: si ambos traen texto, el pedido es lo ultimo que hizo el
     usuario y gana (runSearch descarta la anterior). El modo se lee de un ref
     para no volver a suscribirse en cada cambio. */
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    const take = () => {
      const text = takeSearch();
      if (!text) return;
      setQ(text);
      runSearch(text, modeRef.current);
    };
    take();
    return subscribeSearch(take);
  }, [runSearch]);

  const fullCount = useMemo(
    () => results.filter((t) => trackState(t) === "full").length,
    [results]
  );

  const shown = useMemo(
    () => (filter === "full" ? results.filter((t) => trackState(t) === "full") : results),
    [results, filter]
  );

  const healthByName = useMemo(() => {
    const m = {};
    (health?.sources || []).forEach((s) => {
      m[s.name] = s;
    });
    return m;
  }, [health]);

  /* Con yt-dlp apagado el modo "YouTube" no devuelve nada. No se
     deshabilita (el usuario podria estar reactivandolo desde otra pestana),
     pero se marca para que el 0 de resultados no parezca un fallo. */
  const ytOn = healthByName.ytdlp?.active;
  const ytDead = health !== null && !ytOn;

  /* Con yt-dlp apagado, el modo Música es el que se abre por defecto y
     devuelve "30 resultados, 0 descargables" sin decir por que: iTunes solo
     tiene previews de 30 s y el audio completo sale de YouTube. El aviso
     existia para el modo que se elige a mano (.mode--dead), no para el que
     arranca solo. Sin esto, con el server sin YTDLP_ENABLED=1, la primera
     pantalla parece una app rota. */
  const matchedDead =
    ytDead && mode === "matched" && results.length > 0 && fullCount === 0;

  /* Con "solo vídeo" o "audio y vídeo" el archivo que baja YouTube es un
     mp4/webm: ni el formato de audio (mp3/m4a/original) ni su aviso tienen
     sentido, y el selector se esconde. */
  const audioOnly = !(mode === "ytdlp" && media !== "audio");

  /* Mensaje para lectores de pantalla: los resultados cambian sin mover el foco. */
  const srMsg = loading
    ? "Buscando…"
    : searched && !err
    ? results.length
      ? `${results.length} ${results.length === 1 ? "resultado" : "resultados"} para «${query}»`
      : "Sin resultados"
    : "";

  return (
    <>
      <p className="sr-only" role="status" aria-live="polite">
        {srMsg}
      </p>

      <section className="hero">
        <h1 className="hero__title">Descarga contenido libremente</h1>

        <div className="finder">
          <form
            onSubmit={doSearch}
            role="search"
            className={cx("search", scanning && "is-scanning")}
            onAnimationIteration={(e) => {
              if (!loading && e.target.classList.contains("search__icon")) setScanning(false);
            }}
          >
            <MagnifyingGlass size={22} className="search__icon" />
            <input
              ref={inputRef}
              type="search"
              name="q"
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={PLACEHOLDER[mode] || PLACEHOLDER.default}
              aria-label="Qué quieres escuchar"
            />
            <button type="submit" className="search__go">
              {loading ? "Buscando" : "Buscar"}
            </button>
          </form>

          <section className="controls" aria-label="Cómo buscar">
            <ModePicker value={mode} onChange={setMode} ytDead={ytDead} />
            {mode === "ytdlp" && (
              <MediaPicker value={media} onChange={setMedia} />
            )}
            {audioOnly && <FmtPicker value={fmt} onChange={setFmt} />}
          </section>
          {audioOnly && fmt === "original" && (
            <p className="finder__hint" key={mode === "ytdlp" ? "yt" : "any"}>
              {mode === "ytdlp" ? ORIGINAL_HINT_YT : ORIGINAL_HINT}
            </p>
          )}
        </div>
      </section>

      {err && (
        <div className="msg msg--err" role="alert" ref={msgRef} tabIndex={-1}>
          <WarningCircle size={17} weight="fill" />
          <span>
            {err}
            {botCheck && (
              <button
                type="button"
                className="vf vf--retry"
                onClick={() => onImportCookies()}
              >
                Importar cookies
              </button>
            )}
          </span>
        </div>
      )}
      <ProgressStack jobs={jobs} />
      {matchedDead && (
        <div className="msg msg--warn" role="status">
          <WarningCircle size={17} weight="fill" />
          <span>
            YouTube está apagado en el servidor, y es de ahí de donde sale el
            audio completo. Por eso estos {results.length} resultados no se
            pueden descargar: iTunes solo tiene previews de 30 segundos.
          </span>
        </div>
      )}
      {done && (
        <div
          key={done.filename || done.warning}
          className={`msg ${done.warning ? "msg--warn" : "msg--ok"}`}
          style={{ "--dismiss": `${JOB_DISMISS_MS}ms` }}
          role="status"
          ref={msgRef}
        >
          {done.warning ? (
            <WarningCircle size={17} weight="fill" />
          ) : (
            <CheckCircle size={17} weight="fill" />
          )}
          <span>
            {done.warning
              ? done.warning
              : `${done.filename} está en tu biblioteca${
                  done.size_mb ? ` (${fmtSize(done.size_mb)})` : ""
                }.`}
            {!done.warning && done.real_title && done.match === "match" && (
              <span className="msg__sub">verificado: {done.real_title}</span>
            )}
          </span>
        </div>
      )}

      {librarySlot}

      {results.length > 0 && (
        <>
          <div
            ref={resultsRef}
            tabIndex={-1}
            className={cx("results__head", loading && "is-stale")}
          >
            <span className="results__count">
              <b>{results.length}</b> resultados para <b>{query}</b>,{" "}
              <b>{fullCount} descargables</b>
            </span>
            <FilterSegs
              filter={filter}
              onChange={setFilter}
              total={results.length}
              full={fullCount}
            />
          </div>
          <ul
            className={cx("rows", loading && "is-stale")}
            aria-busy={loading || undefined}
            inert={loading ? "" : undefined}
          >
            {shown.map((t, i) =>
              t.extra?.is_group && t.extra?.track_count > 1 ? (
                <ShowGroup
                  key={t.source + t.source_id}
                  t={t}
                  query={query}
                  onDownload={onDownload}
                  busyIds={busyIds}
                  downloadedIds={downloadedIds}
                />
              ) : (
                <Track
                  key={t.source + t.source_id}
                  t={t}
                  query={query}
                  media={media}
                  busy={busyIds.has(rowKey(t))}
                  downloaded={downloadedIds.has(rowKey(t))}
                  onDownload={onDownload}
                  onBotCheck={onBotCheck}
                  menuOpen={menuKey === rowKey(t)}
                  setMenuOpen={setMenuOpen}
                  index={i}
                />
              )
            )}
          </ul>
          {shown.length === 0 && (
            <div className="none">
              <h3 className="none__h">Ningún resultado con descarga completa</h3>
              <p className="none__p">
                Hay {results.length} resultados, pero todos son previews de 30 segundos o
                temas que no coinciden con lo que buscaste. Prueba con Todas las fuentes.
              </p>
            </div>
          )}
        </>
      )}

      {loading && !results.length && (
        <ul className="rows" aria-label="Buscando" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <SkeletonRow key={i} i={i} />
          ))}
        </ul>
      )}

      {!loading && !results.length && !err && !searched && (
        <section className="intro">
          <Sparkle size={26} weight="fill" className="intro__mark" />
          <h2 className="intro__h">Escribe un tema y descárgalo completo</h2>
          <p className="intro__p">
            Spitifo busca a la vez en varias fuentes de música libre y te dice, resultado
            por resultado, si el archivo se descarga completo.
          </p>
          <p className="intro__lbl">Prueba con alguno de estos</p>
          <ul className="examples">
            {EXAMPLES.map((ex, i) => (
              <li key={ex} style={{ "--i": i }}>
                <button type="button" className="example" onClick={() => runExample(ex)}>
                  <Waveform size={13} />
                  {ex}
                </button>
              </li>
            ))}
          </ul>
          <p className="intro__fine">
            Internet Archive y Wikimedia liberan los archivos. iTunes sirve para
            encontrar la ficha y la portada. De YouTube sale el audio completo del tema.
          </p>
        </section>
      )}

      {!loading && !results.length && searched && !err && (
        <div className="none" ref={resultsRef} tabIndex={-1}>
          <h3 className="none__h">No encontré nada para "{query}"</h3>
          <p className="none__p">
            Prueba con menos palabras, con el nombre del artista solo, o cambia a Todas
            las fuentes para buscar en iTunes, Internet Archive, Wikimedia y YouTube.
          </p>
        </div>
      )}
    </>
  );
}
