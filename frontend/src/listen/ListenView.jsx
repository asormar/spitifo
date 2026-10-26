import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { keyUrl } from "../shared/api.js";
import { engine } from "../player/engine.js";
import { openVideo } from "../player/videoStore.js";
import { normalizeLibrary, toQueue, toTrack } from "./library.js";
import { buildIndex, searchLibrary, sortEntries } from "./home.js";
import { history, useHistory } from "./history.js";
import {
  subscribeReveal,
  takeLibrary,
  takePlaylist,
  takeReveal,
} from "./reveal.js";
import { playlists, usePlaylists } from "./playlists.js";
import { useNotice } from "./Notice.jsx";
import PlaylistPicker from "./PlaylistPicker.jsx";
import useViewStack from "./useViewStack.js";
import HomeFeed from "./HomeFeed.jsx";
import SearchResults from "./SearchResults.jsx";
import { AllPage, DetailPage, LibraryPage } from "./Pages.jsx";
import { Icon } from "./icons.jsx";
import { SongRow } from "./rows.jsx";
import "./home.css";

/* ---------------------------------------------------------------------------
   ESCUCHAR

   Un inicio con buscador grande (seguir escuchando, lo ultimo que llego, lo mas
   escuchado, artistas, albumes, listas) y, encima, una pila de paginas: "Ver
   todo", Explorar la biblioteca, y la ficha de un album, un artista o una
   lista. La cola vive en "Ahora suena".

   ListenView es dueno de lo que se comparte: la busqueda, el menu de fila
   abierto, el aviso, el scroll de cada vista y las peticiones de "ir a" del
   mini-reproductor (una cancion), del riel (una lista) y de Descargar (la
   biblioteca). Las paginas se apilan con useViewStack, que lleva el historial
   del navegador: el atras de Android las cierra una a una.
   ------------------------------------------------------------------------- */

/* Filas de esqueleto mientras llega la biblioteca. */
const skeleton = (n) =>
  Array.from({ length: n }, (_, i) => (
    <div key={i} className="lskel skel skel--pulse" style={{ "--i": i }} aria-hidden="true">
      <span className="art" />
      <span className="lskel__t" />
    </div>
  ));

const keyOf = (view) =>
  view ? `${view.type}:${view.what ?? view.id ?? ""}` : "home";

export default function ListenView({
  files,
  ready,
  error,
  errorCode,
  health,
  active,
  onOpenStorage,
  onRetry,
  onGoDownload,
}) {
  const nav = useViewStack();
  const { stack } = nav;
  const [q, setQ] = useState("");
  /* Escribir no tiene que esperar a que se filtre y se pinte. */
  const dq = useDeferredValue(q);
  /* Orden de Explorar la biblioteca; Descargar lo pide en "recent". */
  const [sort, setSort] = useState("recent");
  /* { key, el }: la fila con el menu abierto y su boton. Solo hay uno. */
  const [menu, setMenu] = useState(null);
  /* { key, title, el }: la cancion de la hoja "Añadir a una lista". */
  const [picker, setPicker] = useState(null);
  const [noticeNode, show] = useNotice();
  const [revealTick, setRevealTick] = useState(0);

  const lists = usePlaylists((s) => s.list);
  const listsReady = usePlaylists((s) => s.ready);
  const hist = useHistory();

  const searchRef = useRef(null);
  const libRef = useRef(null);
  const scrolls = useRef(new Map());
  const wanted = useRef(null);
  const revealRef = useRef(null);
  const firstView = useRef(true);

  const entries = useMemo(() => normalizeLibrary(files), [files]);
  const index = useMemo(() => buildIndex(entries), [entries]);
  const byKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const plays = useMemo(
    () => Object.fromEntries(Object.entries(hist.tracks).map(([k, t]) => [k, t.plays])),
    [hist.tracks]
  );

  const top = stack[stack.length - 1];
  const page = top && top.type !== "search" ? top : null;
  const searching = dq.trim() !== "";
  const results = useMemo(
    () => (searching ? searchLibrary(index, dq, { lists, plays }) : null),
    [searching, index, dq, lists, plays]
  );

  /* --- Pila, scroll y busqueda -------------------------------------------- */

  /* Cada vista (el inicio o una pagina) recuerda su scroll: volver la deja
     donde estaba y una pagina nueva empieza por arriba. */
  const viewKey = keyOf(page);

  const open = (view) => {
    scrolls.current.set(viewKey, window.scrollY);
    scrolls.current.delete(keyOf(view));
    setMenu(null);
    nav.push(view);
  };
  const back = () => {
    setMenu(null);
    nav.pop();
  };

  useLayoutEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    window.scrollTo(0, scrolls.current.get(viewKey) ?? 0);
  }, [viewKey]);

  /* Un atras del navegador cierra tambien el menu abierto. */
  useEffect(() => setMenu(null), [stack]);

  /* La busqueda activa es una entrada de la pila (debajo de las paginas): el
     atras la cierra, y al cerrarse la consulta se vacia. */
  const hasSearch = stack.some((v) => v.type === "search");
  useEffect(() => {
    if (!hasSearch) setQ((cur) => (cur ? "" : cur));
  }, [hasSearch]);

  const onSearch = (value) => {
    setQ(value);
    setMenu(null);
    const has = nav.getStack().some((v) => v.type === "search");
    if (value.trim() && !has) nav.push({ type: "search" });
    else if (!value.trim() && has) nav.pop();
  };

  const clearSearch = () => {
    onSearch("");
    searchRef.current?.focus({ preventScroll: true });
  };

  /* --- Ir a... (mini-reproductor, riel, Descargar) ------------------------- */

  /* La peticion se atiende solo con la pantalla a la vista. Una lista se abre
     como pagina; la biblioteca, con el orden pedido; una cancion, en la
     biblioteca y centrada en su fila. Cada una sustituye a las paginas que
     hubiera abiertas. */
  revealRef.current = () => {
    const list = takePlaylist();
    if (list !== null) {
      nav.reset({ type: "list", id: list });
      return;
    }
    const sortWanted = takeLibrary();
    if (sortWanted !== null) {
      setSort(sortWanted);
      nav.reset({ type: "library" });
      return;
    }
    const key = takeReveal();
    if (key === null || !byKey.has(key)) return;
    wanted.current = key;
    nav.reset({ type: "library" });
    setRevealTick((n) => n + 1);
  };

  useEffect(() => {
    if (!active) return undefined;
    const run = () => revealRef.current();
    run();
    return subscribeReveal(run);
  }, [active]);

  /* Con la biblioteca ya pintada, la fila pedida se centra. Se espera un
     momento: si la peticion llego al cerrar "Ahora suena" (un atras del
     historial), el navegador restaura despues el scroll de la entrada y
     pisaria este. */
  useEffect(() => {
    const key = wanted.current;
    if (key === null || page?.type !== "library") return;
    const i = sortEntries(index.entries, sort).findIndex((e) => e.key === key);
    wanted.current = null;
    if (i >= 0) setTimeout(() => libRef.current?.scrollToIndex(i), 120);
  }, [revealTick, page, index, sort]);

  /* --- Menu de fila y aviso ------------------------------------------------ */

  /* Con teclado el foco vuelve al boton que abrio el menu. */
  const closeMenu = (refocus) => {
    if (refocus) menu?.el.focus({ preventScroll: true });
    setMenu(null);
  };

  /* Fuera del menu, con scroll o con Escape se cierra. El boton de otra fila
     queda fuera de la excepcion a proposito: su clic ya cambia el menu. */
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onDown = (e) => {
      if (!e.target.closest(".rmenu, .srow__more")) close();
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", close, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", close);
    };
  }, [menu]);

  /* Las listas y el historial se piden al montar Escuchar, una vez; los fallos
     de escritura de las listas (que ya deshizo el almacen) se dicen en el
     aviso de esta pantalla. */
  useEffect(() => {
    playlists.load();
    history.load();
    return playlists.onError(show);
  }, [show]);

  const onMenu = (key, el) => setMenu((m) => (m && m.key === key ? null : { key, el }));

  const pick = (entry, kind) => {
    if (kind === "list") {
      setPicker({ key: entry.key, title: entry.title, el: menu?.el });
      setMenu(null);
      return;
    }
    const track = toTrack(entry, keyUrl);
    /* Con el motor parado las dos opciones arrancan la cancion: el aviso tiene
       que decir eso y no "a continuacion". */
    const idle = !engine.getState().track;
    const done = kind === "next" ? engine.playNext(track) : engine.enqueue(track);
    closeMenu(true);
    show(
      idle
        ? "Reproduciendo"
        : !done
          ? "Ya está en la cola"
          : kind === "next"
            ? "Sonará a continuación"
            : "Añadida a la cola"
    );
  };

  const closePicker = () => {
    if (picker?.el?.isConnected) picker.el.focus({ preventScroll: true });
    setPicker(null);
  };

  /* Borrar es inmediato y se puede deshacer unos segundos: la lista vuelve con
     el mismo id, nombre y canciones. */
  const deleteList = (pl) => {
    setMenu(null);
    playlists.remove(pl.id);
    nav.pop();
    show(`Lista «${pl.name}» borrada`, { label: "Deshacer", run: () => playlists.undoRemove(pl) });
  };

  /* --- Teclado -------------------------------------------------------------- */

  /* "/" lleva el foco al buscador (solo en el inicio) y Escape cierra, de lo
     mas pequeno a lo mas grande: el menu, la pagina, la busqueda. Solo con
     Escuchar a la vista: las pantallas ocultas siguen montadas y escuchando el
     documento. */
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (e.key === "/" && !page && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const a = document.activeElement;
        if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
        if (!searchRef.current) return;
        e.preventDefault();
        searchRef.current.focus();
      } else if (e.key === "Escape") {
        if (menu) closeMenu(true);
        else if (page) back();
        else if (q) clearSearch();
      } else if (e.key === "Tab" && menu) {
        setMenu(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  /* --- Reproduccion ---------------------------------------------------------- */

  const play = (entry, el, list) => {
    if (entry.kind === "video") {
      /* Un video no entra en la cola: se abre en el VideoHost. */
      openVideo(
        { src: keyUrl(entry.key), title: entry.title, artist: entry.artist, hasAudio: entry.hasAudio },
        el
      );
      return;
    }
    const queue = toQueue(list, keyUrl);
    engine.play(toTrack(entry, keyUrl), {
      queue,
      index: queue.findIndex((t) => t.key === entry.key),
    });
  };

  /* Pulsar la que suena la pausa o la reanuda; otra, la pone. */
  const tap = (entry, el, list) => {
    if (engine.getState().track?.key === entry.key) engine.toggle();
    else play(entry, el, list);
  };

  /* "Reproducir" / "Aleatorio" de un grupo. Con aleatorio se empieza por una al
     azar, no siempre por la primera; restart: aunque ya suene esa pista, el
     grupo nuevo sustituye a la cola. */
  const playGroup = (group, shuffle = false) => {
    const queue = toQueue(group, keyUrl);
    if (!queue.length) return;
    if (shuffle) engine.setShuffle(true);
    const i = engine.getState().shuffle ? Math.floor(Math.random() * queue.length) : 0;
    engine.play(queue[i], { queue, index: i, restart: true });
  };

  /* Seguir escuchando: la cola son las pistas a medias y la elegida retoma
     donde se quedo. */
  const resume = (item, items) => {
    const queue = toQueue(
      items.map((i) => i.entry),
      keyUrl
    );
    const at = queue.findIndex((t) => t.key === item.entry.key);
    engine.play(queue[at], { queue, index: at, at: item.at });
  };

  /* Lo que reciben las vistas. Se rehace en cada render: lleva el menu abierto. */
  const ctx = {
    menu,
    onMenu,
    closeMenu,
    play,
    tap,
    playGroup,
    resume,
    open,
    back,
    deleteList,
    song: (entry, list, extra) => (
      <SongRow
        key={entry.key}
        entry={entry}
        menuOpen={menu?.key === entry.key}
        onPlay={(e, el) => play(e, el, list)}
        onMenu={onMenu}
        onPick={pick}
        {...extra}
      />
    ),
  };

  /* --- Pintado ---------------------------------------------------------------- */

  /* Cargas que fallaron: reconectar si caduco la sesion, reintentar si no. */
  const failure = (text, code, retry) => (
    <p className="lnote" role="alert">
      {code === "reconnect_required" ? (
        <>
          Tu sesión de Google Drive ha caducado.
          <br />
          <button type="button" className="vf" onClick={() => onOpenStorage()}>
            Volver a conectar
          </button>
        </>
      ) : (
        <>
          {text}
          <br />
          <button type="button" className="vf" onClick={retry}>
            Reintentar
          </button>
        </>
      )}
    </p>
  );

  const common = { index, byKey, lists, listsReady, active, ctx };
  let body;
  if (!ready) {
    body = error ? (
      failure("No se pudo cargar la biblioteca.", errorCode, onRetry)
    ) : (
      <div className="lpanel" aria-busy="true">
        {skeleton(8)}
      </div>
    );
  } else if (!entries.length) {
    body = (
      <p className="lnote">
        Todavía no has descargado nada.
        <br />
        <button type="button" className="vf" onClick={onGoDownload}>
          Ir a Descargar
        </button>
      </p>
    );
  } else {
    body = (
      <>
        <div className="hsearch">
          <div className="hsearch__box">
            <Icon name="MagnifyingGlass" size={22} aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              inputMode="search"
              enterKeyHint="search"
              value={q}
              placeholder="¿Qué quieres escuchar?"
              aria-label="Buscar en tu biblioteca"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onSearch(e.target.value)}
            />
            {q && (
              <button type="button" className="hsearch__clear" aria-label="Borrar búsqueda" onClick={clearSearch}>
                <Icon name="X" size={16} />
              </button>
            )}
          </div>
        </div>
        {searching ? (
          <SearchResults r={results} query={dq} byKey={byKey} ctx={ctx} />
        ) : (
          <HomeFeed index={index} byKey={byKey} lists={lists} listsReady={listsReady} ctx={ctx} />
        )}
      </>
    );
  }

  let pageEl = null;
  if (page && ready) {
    if (page.type === "all") {
      pageEl = <AllPage key={viewKey} view={page} r={results || EMPTY_RESULTS} {...common} />;
    } else if (page.type === "library") {
      pageEl = <LibraryPage key={viewKey} ref={libRef} index={index} sort={sort} onSort={setSort} active={active} ctx={ctx} />;
    } else {
      pageEl = <DetailPage key={viewKey} view={page} {...common} />;
    }
  }

  return (
    <section className="listen" aria-label="Escuchar">
      {pageEl || (
        <>
          <header className="lhead">
            <h1 className="lhead__h" id="listen-title">
              Escuchar
              {ready && files.length > 0 && <span className="count">{files.length}</span>}
            </h1>
            {health?.library && (
              <button
                type="button"
                className="panel__store"
                onClick={() => onOpenStorage()}
                title="Cambiar dónde se guarda tu música"
              >
                {/^Google Drive/.test(health.library) ? (
                  <Icon name="GoogleDriveLogo" size={15} aria-hidden="true" />
                ) : (
                  <Icon name="HardDrives" size={15} aria-hidden="true" />
                )}
                <span className="panel__path">{health.library}</span>
              </button>
            )}
          </header>
          {body}
        </>
      )}

      {noticeNode}

      {picker && (
        <PlaylistPicker
          songKey={picker.key}
          title={picker.title}
          onNotice={show}
          onClose={closePicker}
        />
      )}
    </section>
  );
}

/* Las paginas de "Ver todo" de resultados solo existen con consulta; sin ella
   (la busqueda ya se cerro) no hay nada que listar. */
const EMPTY_RESULTS = { songs: [], artists: [], albums: [], lists: [] };
