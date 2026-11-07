import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNav } from "../app/useNav.js";
import { rowKey } from "../shared/api.js";
import SearchField from "../shared/SearchField.jsx";
import { cx } from "../shared/ui.jsx";
import { usePc } from "../shared/viewport.js";
import {
  FORMATS,
  MEDIA_OPTIONS,
  MODES,
  ORIGINAL_HINT,
  ORIGINAL_HINT_YT,
  PLACEHOLDER,
} from "./constants.js";
import { noticeFromError, resultsHead, summarize } from "./searchPlan.js";
import useDownloads from "./useDownloads.js";
import useSearchRun from "./useSearchRun.js";
import Choice from "./Choice.jsx";
import Ficha from "./Ficha.jsx";
import Idle from "./Idle.jsx";
import LibraryHits from "./LibraryHits.jsx";
import { ResultRow, Skeleton } from "./ResultRow.jsx";
import ResolutionMenu from "./ResolutionMenu.jsx";
import ShowGroup from "./ShowGroup.jsx";
import Strip from "./Strip.jsx";
import "./search.css";
import "./rows.css";
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

  /* La ficha y el menu de resoluciones viven en la pila de navegacion: atras,
     Escape y el atras de Android los cierran. El menu es el de arriba de la
     pila; encima de la ficha, si se abre desde ella. */
  const nav = useNav();
  const stack = nav.stackOf("search");
  const menuAt = stack.at(-1)?.type === "resmenu" ? stack.at(-1) : null;
  const fichaAt = stack.find((e) => e.type === "ficha");
  const menuT = menuAt && results.find((t) => rowKey(t) === menuAt.key);
  const fichaT = fichaAt && results.find((t) => rowKey(t) === fichaAt.key);
  /* Una busqueda nueva se lleva el resultado: lo abierto ya no apunta a nada. */
  useEffect(() => {
    if (menuAt && !menuT) nav.back();
  }, [menuAt, menuT, nav.back]);
  useEffect(() => {
    if (fichaAt && !fichaT) nav.back();
  }, [fichaAt, fichaT, nav.back]);

  /* Con video el boton abre el menu de resoluciones en vez de bajar; pulsar otra
     vez el mismo lo cierra. */
  const onDl = useCallback(
    (t, el) => {
      const key = rowKey(t);
      const now = nav.getStack().at(-1);
      if (now?.type === "resmenu" && now.key === key) {
        nav.back();
      } else if (mode === "ytdlp" && media !== "audio" && t.extra?.webpage_url) {
        nav.open({ type: "resmenu", key, anchor: el });
      } else {
        dl.onDownload(t);
      }
    },
    [mode, media, nav.open, nav.back, nav.getStack, dl.onDownload]
  );

  const pickHeight = useCallback(
    (t, height) => {
      nav.back();
      dl.onDownload(t, height);
    },
    [nav.back, dl.onDownload]
  );

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

  const { full: fullCount, shown, filterEmpty } = useMemo(() => summarize(results, filter), [results, filter]);

  /* Las filas entran una tras otra SOLO con resultados nuevos: volver a la
     pantalla (display:none -> block) no debe repetirlo, y .screen[data-seen] no
     sirve aqui porque los resultados llegan despues de verla por primera vez. */
  const [settled, setSettled] = useState(null);
  const fresh = results.length > 0 && settled !== results;
  useEffect(() => {
    if (!fresh) return undefined;
    const id = setTimeout(() => setSettled(results), 700);
    return () => clearTimeout(id);
  }, [fresh, results]);

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
        <Strip tone="err" innerRef={msgRef} onClose={dl.notice ? dl.clearNotice : undefined}>
          {notice.text}
          {notice.cookies && (
            <button type="button" className="vf vf--retry" onClick={() => onImportCookies()}>
              Importar cookies
            </button>
          )}
        </Strip>
      )}
      {matchedDead && (
        <Strip tone="warn">
          YouTube está apagado en el servidor, y es de ahí de donde sale el audio completo. Por eso estos{" "}
          {results.length} resultados no se pueden descargar: iTunes solo tiene previews de 30 segundos.
        </Strip>
      )}
      {notice && notice.tone !== "err" && (
        <Strip
          key={notice.key || notice.text}
          tone={notice.tone}
          innerRef={msgRef}
          onClose={dl.clearNotice}
        >
          {notice.text}
          {notice.sub && <b>{notice.sub}</b>}
        </Strip>
      )}

      <LibraryHits active={active} />

      {!searched && (
        <Idle files={files} active={active} onExample={runExample} onOpenLibrary={onOpenLibrary} />
      )}

      {results.length > 0 && (
        <section className={cx("rsec", loading && "is-stale")} aria-labelledby="rs-h">
          <div className="rhead">
            <div>
              <h2 className="sh2" id="rs-h" ref={resultsRef} tabIndex={-1}>
                Para descargar
              </h2>
              <p className="rhead__s">{resultsHead(results.length, fullCount, query)}</p>
            </div>
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
          {!filterEmpty && (
            <div className="thead" aria-hidden="true">
              <span>#</span>
              <span>Título</span>
              <span>Fuente</span>
              <span>Detalles</span>
            </div>
          )}
          <ul
            className="rlist"
            data-in={fresh ? "" : undefined}
            aria-busy={loading || undefined}
            inert={loading ? "" : undefined}
          >
            {shown.map((t, i) =>
              t.extra?.is_group && t.extra?.track_count > 1 ? (
                <ShowGroup
                  key={t.source + t.source_id}
                  t={t}
                  i={i}
                  query={query}
                  onDl={dl.onDownload}
                  busyIds={dl.busyIds}
                  downloadedIds={dl.downloadedIds}
                />
              ) : (
                <ResultRow
                  key={t.source + t.source_id}
                  t={t}
                  i={i}
                  query={query}
                  busy={dl.busyIds.has(rowKey(t))}
                  downloaded={dl.downloadedIds.has(rowKey(t))}
                  onDl={onDl}
                  onOpen={nav.open}
                />
              )
            )}
          </ul>
          {filterEmpty && (
            <div className="empty">
              <h3>Ningún resultado con descarga completa</h3>
              <p>
                Hay {results.length} resultados, pero todos son previews de 30 segundos o temas que no
                coinciden con lo que buscaste. Prueba con Todas las fuentes.
              </p>
            </div>
          )}
        </section>
      )}

      {loading && !results.length && <Skeleton />}

      {!loading && !results.length && searched && !err && (
        <div className="empty" ref={resultsRef} tabIndex={-1}>
          <h3>No encontré nada para «{query}»</h3>
          <p>
            Prueba con menos palabras, con el nombre del artista solo, o cambia a Todas las fuentes para
            buscar en iTunes, Internet Archive, Wikimedia y YouTube.
          </p>
        </div>
      )}

      {fichaT && (
        <Ficha
          key={`f${fichaAt.key}`}
          t={fichaT}
          query={query}
          anchor={fichaAt.anchor}
          busy={dl.busyIds.has(fichaAt.key)}
          downloaded={dl.downloadedIds.has(fichaAt.key)}
          onDl={onDl}
          onClose={nav.back}
        />
      )}

      {menuT && (
        <ResolutionMenu
          key={`m${menuAt.key}`}
          t={menuT}
          anchor={menuAt.anchor}
          onPick={(height) => pickHeight(menuT, height)}
          onClose={nav.back}
          onBotCheck={dl.onBotCheck}
        />
      )}
    </div>
  );
}
