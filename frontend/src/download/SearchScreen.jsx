import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { rowKey } from "../shared/api.js";
import SearchField from "../shared/SearchField.jsx";
import { cx } from "../shared/ui.jsx";
import { usePc } from "../shared/viewport.js";
import {
  FORMATS,
  JOB_DISMISS_MS,
  MEDIA_OPTIONS,
  MODES,
  ORIGINAL_HINT,
  ORIGINAL_HINT_YT,
  PLACEHOLDER,
} from "./constants.js";
import { noticeFromError, summarize } from "./searchPlan.js";
import useDownloads from "./useDownloads.js";
import useSearchRun from "./useSearchRun.js";
import Choice from "./Choice.jsx";
import Idle from "./Idle.jsx";
import LibraryHits from "./LibraryHits.jsx";
import { ShowGroup, SkeletonRow, Track } from "./cards.jsx";
import "./search.css";
import "./results.css";
import "./cards.css";
import "./resolution-menu.css";
import "./notices.css";

/* ---------------------------------------------------------------------------
   BUSCAR

   Solo la disposicion de la pantalla. La busqueda (texto, modo, URL, resultados)
   vive en useSearchRun y las descargas en useDownloads; aqui se juntan, se
   pintan y se cuida el foco y el scroll de los avisos.
   ------------------------------------------------------------------------- */

const FMT_OPTIONS = FORMATS.map((f) => ({ id: f.value, label: f.label, title: f.title }));

export default function SearchScreen({
  active,
  health,
  files,
  onLibraryChanged,
  onImportCookies,
  onOpenLibrary,
}) {
  const pc = usePc();
  const run = useSearchRun();
  const { q, setQ, mode, setMode, query, results, loading, searched, err, filter, setFilter } = run;

  const [fmt, setFmt] = useState("mp3");
  /* Qué partes se bajan en modo YouTube. Vive acá y no en el selector para que
     cambiar de modo y volver no lo reinicie (como fmt). */
  const [media, setMedia] = useState("audio");
  /* Clave del resultado cuyo menú de resoluciones está abierto. Vive acá y no
     en cada tarjeta para que abrir uno cierre el anterior: un menú a la vez. */
  const [menuKey, setMenuKey] = useState(null);
  const dl = useDownloads({ query, mode, fmt, media, runs: run.runs, onLibraryChanged });

  const inputRef = useRef();
  /* Aviso visible en cada momento: se usa para traerlo a pantalla si una
     descarga lejana lo deja fuera de vista. */
  const msgRef = useRef(null);
  /* Foco tras pulsar un ejemplo: el boton se desmonta al buscar y el foco caia
     al <body>. `focusPending` lo marca runExample; `resultsRef` es la cabecera
     de resultados (o el bloque de "sin resultados"). */
  const focusPending = useRef(false);
  const resultsRef = useRef(null);

  /* Abrir/cerrar el menú de resoluciones por clave. Cerrar una clave que ya no
     es la abierta no pisa a la que sí lo está (dos tarjetas no se pelean). */
  const setMenuOpen = useCallback((key, open) => {
    setMenuKey((cur) => (open ? key : cur === key ? null : cur));
  }, []);

  /* Un fallo de busqueda y uno de descarga son el mismo aviso: el ultimo. */
  const notice = dl.notice || (err ? noticeFromError(err) : null);

  /* Un fallo/exito de descarga desde una tarjeta lejana pintaba el aviso bajo
     el hero, fuera de vista. Solo se hace scroll si de verdad esta fuera. */
  useEffect(() => {
    if (!notice) return;
    const el = msgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    /* La barra de arriba (escritorio, --top-h) tapa el borde de la pagina. */
    const bar = parseFloat(getComputedStyle(document.body).getPropertyValue("--top-h")) || 0;
    if (r.top >= bar + 16 && r.bottom <= window.innerHeight) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [notice]);

  const onSubmit = useCallback(
    (e) => {
      e.preventDefault();
      /* Una busqueda manual no debe heredar un foco pendiente de un ejemplo. */
      focusPending.current = false;
      run.submit();
      /* En movil se baja el teclado para ver los resultados. */
      if (window.matchMedia("(pointer: coarse)").matches) inputRef.current?.blur();
    },
    [run.submit]
  );

  const runExample = useCallback(
    (text) => {
      setQ(text);
      focusPending.current = true;
      run.run(text, mode);
    },
    [mode, run.run, setQ]
  );

  /* Se espera a que la busqueda termine: antes no hay nada donde poner el
     foco. Va a la cabecera de resultados (o al aviso de error / sin
     resultados), nunca al input, que abriria el teclado en movil. */
  useEffect(() => {
    if (!focusPending.current || loading || !searched) return;
    focusPending.current = false;
    (resultsRef.current || msgRef.current)?.focus();
  }, [loading, searched, results, err]);

  const { full: fullCount, shown } = useMemo(() => summarize(results, filter), [results, filter]);

  /* Con yt-dlp apagado el modo "YouTube" no devuelve nada. No se
     deshabilita (el usuario podria estar reactivandolo desde otra pestana),
     pero se marca para que el 0 de resultados no parezca un fallo. */
  const ytDead = health !== null && !health?.sources?.some((s) => s.name === "ytdlp" && s.active);

  /* Con yt-dlp apagado, el modo Música es el que se abre por defecto y
     devuelve "30 resultados, 0 descargables" sin decir por que: iTunes solo
     tiene previews de 30 s y el audio completo sale de YouTube. El aviso
     existia para el modo que se elige a mano (.mode--dead), no para el que
     arranca solo. */
  const matchedDead = ytDead && mode === "matched" && results.length > 0 && fullCount === 0;

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

  const modeOptions = MODES.map((m) =>
    m.id === "ytdlp" && ytDead
      ? { ...m, dead: true, title: "YouTube está apagado en este servidor: no devolverá resultados" }
      : m
  );

  return (
    <div className="sscr">
      <p className="sr-only" role="status" aria-live="polite">
        {srMsg}
      </p>

      <header className="lhead">
        <h1 className="lhead__h">Buscar</h1>
      </header>

      {/* En escritorio el campo es el de la barra de arriba. */}
      {!pc && (
        <SearchField
          big
          className="sscr__field"
          inputRef={inputRef}
          value={q}
          onChange={setQ}
          onSubmit={onSubmit}
          go="Buscar"
          busy={loading}
          placeholder={PLACEHOLDER[mode] || PLACEHOLDER.default}
          label="Qué quieres escuchar"
        />
      )}

      <div className="tbar" role="group" aria-label="Cómo buscar">
        <Choice options={modeOptions} value={mode} onChange={setMode} ariaLabel="Modo de búsqueda" />
        {mode === "ytdlp" && (
          <Choice
            label="Contenido"
            options={MEDIA_OPTIONS}
            value={media}
            onChange={setMedia}
            ariaLabel="Qué se descarga de YouTube"
          />
        )}
        {audioOnly && (
          <Choice
            label="Formato"
            options={FMT_OPTIONS}
            value={fmt}
            onChange={setFmt}
            ariaLabel="Formato de descarga"
          />
        )}
      </div>
      {audioOnly && fmt === "original" && (
        <p className="shint" key={mode === "ytdlp" ? "yt" : "any"}>
          {mode === "ytdlp" ? ORIGINAL_HINT_YT : ORIGINAL_HINT}
        </p>
      )}

      {notice?.tone === "err" && (
        <div className="msg msg--err" role="alert" ref={msgRef} tabIndex={-1}>
          <Icon name="WarningCircle" size={17} weight="fill" />
          <span>
            {notice.text}
            {notice.cookies && (
              <button type="button" className="vf vf--retry" onClick={() => onImportCookies()}>
                Importar cookies
              </button>
            )}
          </span>
        </div>
      )}
      {matchedDead && (
        <div className="msg msg--warn" role="status">
          <Icon name="WarningCircle" size={17} weight="fill" />
          <span>
            YouTube está apagado en el servidor, y es de ahí de donde sale el
            audio completo. Por eso estos {results.length} resultados no se
            pueden descargar: iTunes solo tiene previews de 30 segundos.
          </span>
        </div>
      )}
      {notice && notice.tone !== "err" && (
        <div
          key={notice.key || notice.text}
          className={`msg ${notice.tone === "warn" ? "msg--warn" : "msg--ok"}`}
          style={{ "--dismiss": `${JOB_DISMISS_MS}ms` }}
          role="status"
          ref={msgRef}
        >
          {notice.tone === "warn" ? (
            <Icon name="WarningCircle" size={17} weight="fill" />
          ) : (
            <Icon name="CheckCircle" size={17} weight="fill" />
          )}
          <span>
            {notice.text}
            {notice.sub && <span className="msg__sub">{notice.sub}</span>}
          </span>
        </div>
      )}

      <LibraryHits active={active} />

      {!searched && (
        <Idle files={files} active={active} onExample={runExample} onOpenLibrary={onOpenLibrary} />
      )}

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
            <Choice
              kind="toggle"
              options={[
                { id: "all", label: "Todos", n: results.length },
                { id: "full", label: "Descarga completa", n: fullCount },
              ]}
              value={filter}
              onChange={setFilter}
              ariaLabel="Filtrar resultados"
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
                  onDownload={dl.onDownload}
                  busyIds={dl.busyIds}
                  downloadedIds={dl.downloadedIds}
                />
              ) : (
                <Track
                  key={t.source + t.source_id}
                  t={t}
                  query={query}
                  media={media}
                  busy={dl.busyIds.has(rowKey(t))}
                  downloaded={dl.downloadedIds.has(rowKey(t))}
                  onDownload={dl.onDownload}
                  onBotCheck={dl.onBotCheck}
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

      {!loading && !results.length && searched && !err && (
        <div className="none" ref={resultsRef} tabIndex={-1}>
          <h3 className="none__h">No encontré nada para "{query}"</h3>
          <p className="none__p">
            Prueba con menos palabras, con el nombre del artista solo, o cambia a Todas
            las fuentes para buscar en iTunes, Internet Archive, Wikimedia y YouTube.
          </p>
        </div>
      )}
    </div>
  );
}
