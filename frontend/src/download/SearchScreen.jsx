import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNav } from "../app/useNav.js";
import { crossGo } from "../app/crossMode.js";
import ChromeButtons from "../app/ChromeButtons.jsx";
import { rowKey } from "../shared/api.js";
import SearchField from "../shared/SearchField.jsx";
import { cx } from "../shared/ui.jsx";
import { listKey } from "../shared/keyNav.js";
import { usePc } from "../shared/viewport.js";
import { MODES, PLACEHOLDER } from "./constants.js";
import { useDownloadFormat, useDownloadMedia } from "../settings/downloadPrefs.js";
import { catalogFallback, entranceOn, noticeFromError, resultsHead, summarize } from "./searchPlan.js";
import useDownloads from "./useDownloads.js";
import useSearchRun from "./useSearchRun.js";
import AlbumShelf, { AlbumShelfSkeleton } from "./AlbumShelf.jsx";
import BestResult, { BestResultSkeleton } from "./BestResult.jsx";
import { loadAlbumChunk } from "./albumChunk.js";
import { loadArtistChunk } from "./artistChunk.js";
import { bestArtwork, bestMatch } from "./artistLogic.js";
import Choice from "./Choice.jsx";
import Ficha from "./Ficha.jsx";
import Idle from "./Idle.jsx";
import LibraryHits from "./LibraryHits.jsx";
import { ResultRow, Skeleton } from "./ResultRow.jsx";
import { MenuSurface } from "./ResultMenu.jsx";
import { pickResultAction, resultMenuGroups } from "./resultMenuActions.js";
import ResolutionMenu from "./ResolutionMenu.jsx";
import { npLinks } from "../player/npLinks.js";
import { useShow } from "../listen/Notice.jsx";
import { useListen } from "../listen/ListenProvider.jsx";
import ShowGroup from "./ShowGroup.jsx";
import Strip from "./Strip.jsx";
import "../shared/chips.css";
import "./search.css";
import "./rows.css";
import "./notices.css";

/* ---------------------------------------------------------------------------
   BUSCAR

   Solo la disposicion de la pantalla. La busqueda (texto, modo, URL, resultados)
   vive en useSearchRun y las descargas en useDownloads; aqui se juntan, se
   pintan y se cuida el foco y el scroll de los avisos.
   ------------------------------------------------------------------------- */

const LINK_HINT = "Pega un enlace de YouTube";
/* [modo, titulo, linea] para las salidas del catalogo. "link" no cambia de modo. */
const EXITS = [
  ["ytdlp", "Buscar en YouTube", "Canciones completas, sin ficha del disco"],
  ["sources", "Buscar en todas las fuentes", "Incluye Internet Archive y Wikimedia"],
  ["link", "Pegar un enlace de YouTube", "Se descarga directamente"],
];

/* La ficha del album (y la hoja de Descargas) viven en un chunk aparte, que se
   adelanta al enfocar una tarjeta de album. */
const AlbumSheet = lazy(() => loadAlbumChunk().then((m) => ({ default: m.AlbumSheet })));

export default function SearchScreen({
  active,
  health,
  files,
  onLibraryChanged,
  onImportCookies,
  onOpenLibrary,
}) {
  const pc = usePc();
  const show = useShow();
  /* Token del padre: una resolucion de artista que espera la red no debe
     navegar si el usuario se movio mientras tanto. */
  const { ctx: listenCtx } = useListen();
  /* Foco tras buscar: el boton de un ejemplo se desmonta al buscar y el foco
     caia al <body>; en escritorio, ademas, toda busqueda terminada lleva el
     foco a los resultados (tambien las que llegan de la barra de arriba).
     `resultsRef` es la cabecera de resultados (o el bloque de "sin
     resultados"). */
  const focusPending = useRef(false);
  const fine = () => window.matchMedia("(pointer: fine)").matches;
  const run = useSearchRun({ onRequest: () => (focusPending.current = fine()) });
  const { q, setQ, mode, setMode, query, results, catalog, albums, artists, artistQuery, loading, searched, err, filter, setFilter, listRef } = run;
  const { shelvesPending, streamDone } = run;

  /* Formato y contenido se eligen en Ajustes y se leen igual que antes: la
     descarga recibe exactamente estos valores. M4A por defecto (en YouTube es
     la pista AAC del origen, sin recodificar) y solo audio en YouTube. */
  const [fmt] = useDownloadFormat();
  const [media] = useDownloadMedia();
  const dl = useDownloads({ query, mode, fmt, media, runs: run.runs, onLibraryChanged });

  const inputRef = useRef();
  /* Aviso visible en cada momento: se usa para traerlo a pantalla si una
     descarga lejana lo deja fuera de vista. */
  const msgRef = useRef(null);
  const resultsRef = useRef(null);

  /* La ficha y el menu de resoluciones viven en la pila de navegacion: atras,
     Escape y el atras de Android los cierran. El menu es el de arriba de la
     pila; encima de la ficha, si se abre desde ella. */
  const nav = useNav();
  const stack = nav.stackOf("search");
  const menuAt = stack.at(-1)?.type === "resmenu" ? stack.at(-1) : null;
  const resmoreAt = stack.at(-1)?.type === "resmore" ? stack.at(-1) : null;
  const fichaAt = stack.find((e) => e.type === "ficha");
  /* Solo la ficha del estante de Buscar (sin `from`); la que abre la pagina
     del artista o Escuchar trae su propio album en la entrada. */
  const albumAt = stack.find((e) => e.type === "albumsheet" && !e.from);
  const menuT = menuAt && results.find((t) => rowKey(t) === menuAt.key);
  const resmoreT = resmoreAt && results.find((t) => rowKey(t) === resmoreAt.key);
  /* La ficha de una pista del album trae su resultado en la entrada: no esta
     entre los resultados de Buscar. */
  const fichaT = fichaAt?.t || (fichaAt && results.find((t) => rowKey(t) === fichaAt.key));
  const albumT = albumAt && albums.find((a) => String(a.id) === String(albumAt.id));
  /* Una busqueda nueva se lleva el resultado: lo abierto ya no apunta a nada. */
  const gone = (menuAt && !menuT) || (resmoreAt && !resmoreT) || (fichaAt && !fichaT) || (albumAt && !albumT);
  useEffect(() => {
    if (gone) nav.back();
  }, [gone, stack.length, nav.back]);

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

  /* El ⋯ de una fila vive en la pila como la ficha: atras, Escape y el atras de
     Android lo cierran, y el foco vuelve al boton (lo hace Sheet/Popover). */
  const openResultMenu = useCallback(
    (t, anchor) => nav.open({ type: "resmore", key: rowKey(t), anchor }),
    [nav.open]
  );

  /* La ficha del album es otra entrada de la pila, como la de un resultado:
     atras, Escape y el atras de Android la cierran y el foco vuelve a la
     tarjeta que la abrio (lo hace Sheet). */
  const onOpenAlbum = useCallback(
    (album, anchor) => nav.open({ type: "albumsheet", id: album.id, anchor }),
    [nav.open]
  );

  /* «Mejor resultado»: solo si el texto nombra de verdad al primer artista.
     La portada redonda sale del disco mas nuevo que haya entre los resultados
     de albumes; sin el, la tarjeta cae a la inicial. */
  const best = bestMatch(artistQuery, artists);
  const bestArtist = best ? { ...best, artwork_url: bestArtwork(best, albums, results) } : null;
  const onOpenArtist = useCallback(
    (artist, anchor) => {
      loadArtistChunk();
      /* Los resultados viajan en la entrada: el artista abre Populares sin un
         estado global nuevo ni otra peticion. */
      nav.open({
        type: "itunesartist",
        id: artist.id,
        name: artist.name,
        genre: artist.genre,
        songs: results,
        anchor,
      });
    },
    [nav.open, results]
  );

  /* Lo que Buscar hace distinto con el ⋯: adelanta el chunk del album, cae a
     una busqueda si el artista no tiene pagina y baja por onDl (que decide
     entre el menu de resoluciones y la descarga directa). */
  const onAlbumFromResult = useCallback(
    (t, anchor) => {
      loadAlbumChunk();
      nav.open({ ...npLinks({ result: t }, null).album.sheet, anchor });
    },
    [nav.open]
  );
  const onArtistFromResult = useCallback(
    async (t, anchor) => {
      loadArtistChunk();
      const links = npLinks({ result: t }, null);
      if (links.artist?.view) return crossGo(nav, links.artist.view, null);
      if (links.artist?.resolve) {
        const locationToken = listenCtx.locationToken;
        const token = locationToken?.();
        const { resolveArtistLink } = await import("./artistLink.js");
        const view = await resolveArtistLink(links.artist.name, []);
        /* El menu ya se desmonto si el usuario retrocedio o cambio de pantalla
           mientras se buscaba: ni se abre la pagina ni se lanza otra busqueda. */
        if (locationToken && locationToken() !== token) return;
        if (view) return crossGo(nav, view, null);
      }
      const name = links.artist?.name || t.artist;
      setQ(name);
      run.run(name, mode);
    },
    [nav.goTo, setQ, run.run, mode, nav]
  );

  const pickResult = useCallback(
    (kind) =>
      pickResultAction(kind, {
        t: resmoreT,
        query,
        source: query ? `search:${query}` : null,
        onDownload: onDl,
        onAlbum: onAlbumFromResult,
        onArtist: onArtistFromResult,
        show,
        locationToken: listenCtx.locationToken,
        nav,
        anchor: resmoreAt?.anchor,
      }),
    [resmoreT, resmoreAt, query, onDl, onAlbumFromResult, onArtistFromResult, show, listenCtx.locationToken, nav]
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
      /* En escritorio (pointer: fine) toda busqueda terminada lleva el foco a
         los resultados, como los ejemplos. En movil no: el input ya se suelta
         y mover el foco volveria a abrir el teclado. */
      focusPending.current = fine();
      run.submit();
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

  /* "Pegar un enlace": deja el campo vacio y abierto con la pista hasta que
     escriba. El propio input recupera su placeholder al primer caracter; un
     enlace de YouTube ya fuerza el modo en planSubmit. */
  const pasteLink = useCallback(() => {
    setQ("");
    const f = inputRef.current || document.querySelector('.topbar [data-field="search"]');
    if (!f) return;
    f.focus({ preventScroll: true });
    f.placeholder = LINK_HINT;
    f.addEventListener("input", () => { f.placeholder = PLACEHOLDER[mode] || PLACEHOLDER.default; }, { once: true });
  }, [mode, setQ]);

  /* Las mismas acciones en el bloque grande y en el aviso de resultados
     debiles; en este ultimo solo caben las dos primeras, en pequeno. */
  const exits = (list, small) => (
    <div className={cx("fb__acts", small && "fb__acts--in")}>
      {list.map(([id, label, sub]) => (
        <button type="button" key={id} className={cx("btn", id === "ytdlp" && "btn--acc")}
          onClick={() => (id === "link" ? pasteLink() : setMode(id))}>
          {label}{!small && <small>{sub}</small>}
        </button>
      ))}
    </div>
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

  /* Las filas entran una tras otra SOLO con la primera lista de cada
     busqueda: los lotes que la completan no la repiten ni alargan el reloj, y
     volver a la pantalla (display:none -> block) tampoco. .screen[data-seen] no
     sirve aqui porque los resultados llegan despues de verla por primera vez. */
  const [settled, setSettled] = useState(0);
  const fresh = entranceOn({ count: results.length, run: run.resultsRun, settled });
  useEffect(() => {
    if (!fresh) return undefined;
    const id = setTimeout(() => setSettled(run.resultsRun), 700);
    return () => clearTimeout(id);
  }, [fresh, run.resultsRun]);

  /* La cola se lee al tocar: una funcion estable deja que memo salte las
     filas que el lote no cambio. */
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const getQueue = useCallback(() => shownRef.current, []);

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

  /* iTunes no tiene la cancion (empty) o la tiene pero no es lo pedido (weak).
     En ambos casos el usuario elige adonde seguir buscando. */
  /* Sin YouTube, "nofull" ya lo explica el aviso de matchedDead. */
  const fallback = matchedDead
    ? null
    : catalogFallback({ mode, catalog, count: results.length, full: fullCount, done: streamDone });
  const small = fallback === "weak" || fallback === "nofull";

  /* Mensaje para lectores de pantalla: los resultados cambian sin mover el foco.
     resultsHead ya cuenta los descargables, asi que se reutiliza. */
  const srMsg = loading
    ? "Buscando…"
    : searched && !err
    ? results.length
      ? resultsHead(results.length, fullCount, streamDone)
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
        {!pc && <ChromeButtons />}
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
      </div>

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

      {/* Hasta el catalogo, los estantes viejos siguen (atenuados, como la
          lista) o, sin ellos, un hueco con su alto: llegar no empuja a las
          canciones. Un estante vacio se va en el mismo pintado que ellas. */}
      {bestArtist ? (
        <section className={cx("bestsec", shelvesPending && "is-stale")} aria-labelledby="best-h">
          <h2 className="sh2" id="best-h">Mejor resultado</h2>
          <BestResult artist={bestArtist} results={results} query={query} onOpen={onOpenArtist} />
        </section>
      ) : (
        shelvesPending && <BestResultSkeleton />
      )}

      {shelvesPending && !albums.length ? (
        <AlbumShelfSkeleton />
      ) : (
        <AlbumShelf albums={albums} stale={shelvesPending} onOpen={onOpenAlbum} />
      )}

      {fallback && !loading && searched && !err && (
        <div className={cx("empty", small && "fbweak")}
          ref={small ? undefined : resultsRef} tabIndex={-1}>
          <h3>
            {small
              ? fallback === "weak"
                ? `No encontré exactamente «${query}» en el catálogo`
                : "Ninguno se puede descargar completo"
              : "No está en el catálogo"}
          </h3>
          {!small && <p>iTunes no tiene «{query}». Puedes buscarla en otro sitio:</p>}
          {exits(EXITS.filter(([id]) => !(id === "ytdlp" && ytDead) && !(id === "link" && small)), small)}
        </div>
      )}

      {results.length > 0 && (
        <section className={cx("rsec", loading && "is-stale")} aria-labelledby="rs-h">
          <div className="rhead">
            <div>
              <h2 className="sh2" id="rs-h" ref={resultsRef} tabIndex={-1}>
                Canciones
              </h2>
              <p className="rhead__s">{resultsHead(results.length, fullCount, streamDone)}</p>
            </div>
            <Choice
              kind="toggle"
              options={[
                { id: "all", label: "Todos", n: results.length },
                { id: "full", label: "Completas", n: streamDone ? fullCount : undefined },
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
            ref={listRef}
            data-in={fresh ? "" : undefined}
            aria-busy={loading || undefined}
            inert={loading}
            onKeyDown={(e) => listKey(e, ".res__main")}
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
                  onMenu={openResultMenu}
                  queue={getQueue}
                  source={query ? `search:${query}` : null}
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

      {!loading && !results.length && searched && !err && fallback !== "empty" && (
        <div className="empty" ref={resultsRef} tabIndex={-1}>
          <h3>No encontré nada para «{query}»</h3>
          <p>
            Prueba con menos palabras, con el nombre del artista solo, o cambia a Todas las fuentes para
            buscar en iTunes, Internet Archive, Wikimedia y YouTube.
          </p>
        </div>
      )}

      {albumAt && albumT && (
        <Suspense fallback={null}>
          <AlbumSheet
            key={`a${albumAt.id}`}
            album={albumT}
            query={query}
            anchor={albumAt.anchor}
            onClose={nav.back}
            onLibraryChanged={onLibraryChanged}
            downloadedIds={dl.downloadedIds}
          />
        </Suspense>
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

      {resmoreT && (
        <MenuSurface
          key={`r${resmoreAt.key}`}
          groups={resultMenuGroups(resmoreT, {
            fmt,
            downloaded: dl.downloadedIds.has(resmoreAt.key),
          })}
          title={resmoreT.title || "sin título"}
          anchor={resmoreAt.anchor}
          onPick={pickResult}
          onClose={nav.back}
        />
      )}
    </div>
  );
}
