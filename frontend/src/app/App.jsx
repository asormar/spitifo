import React, { Suspense, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { API, keyUrl } from "../shared/api.js";
import { COMPACT_FIELDS, compactLibraryRows, expandCompactLibrary } from "./libraryCompact.js";
import MiniPlayer from "../player/MiniPlayer.jsx";
import PlayerBar from "../player/PlayerBar.jsx";
import { onQueueReady, probeQueue } from "../download/queueBoot.js";
import { useShow } from "../listen/Notice.jsx";
import { loadAlbumChunk } from "../download/albumChunk.js";
import VideoHost from "../player/VideoHost.jsx";
import { engine } from "../player/engine.js";
import { panel, panelMode, usePanel } from "../player/panel.js";
import { useEngine } from "../player/useEngine.js";
import { createListenTracker } from "../player/listens.js";
import { bindMediaSession } from "../player/mediaSession.js";
import StreamErrors from "../player/StreamErrors.jsx";
import { fetchMapFile } from "../discover/mapFile.js";
import { requestReveal } from "../listen/revealRequest.js";
import { loadArtistChunk } from "../download/artistChunk.js";
import { requestSearch } from "../download/searchRequest.js";
import ListenProvider from "../listen/ListenProvider.jsx";
import { saved } from "../listen/saved.js";
import { art } from "../listen/art.js";
import { artSrc, songTarget } from "../listen/artLogic.js";
import { loadOverlays, loadPageHost } from "../listen/pageLoader.jsx";
import { ProgressStack } from "../download/progress.jsx";
import {
  TABS,
  aboveNp,
  canStartSwipe,
  nextGuess,
  readPhoneNav,
  readView,
  swipeTarget,
  viewKey,
  writePhoneNav,
} from "./navigation.js";
import { createLocationToken, createNpHistory } from "./npHistory.js";
import useNavController, { NavContext } from "./useNav.js";
import { SwipeDots, TabBar } from "./Nav.jsx";
import LeftNav from "./LeftNav.jsx";
import TopBar from "./TopBar.jsx";
import { isPc, usePc } from "../shared/viewport.js";
import { isSearchShortcut, isTypingTarget } from "./hotkeys.js";
import { swapNowPlaying } from "./screenSwap.js";
import { createPendingDeletes } from "../listen/pending.js";
import { closeDock, registerClosePlayer } from "../player/useDock.js";

/* Ultima biblioteca que respondio el servidor, guardada en el dispositivo.
   Con Drive la lista tarda segundos en llegar (es red): mientras tanto
   Inicio y Tu biblioteca pintan la de la vez anterior y la real la reemplaza
   al llegar. Si el almacenamiento no deja leer o escribir, se sigue sin ella.

   Se guarda en columnas (ver libraryCompact.js), no un objeto por archivo: a
   20k pistas el espejo clasico pesaba ~7.7 MB, el doble contando el
   `JSON.stringify` de cada escritura, y se acercaba a la cuota tipica de
   localStorage (P-large-library-scale-1). "v2" en la clave es la migracion:
   un espejo de la version anterior (un array de objetos) no calza con esta
   forma y se descarta solo, sin romper nada; la red trae la lista de nuevo,
   como si no hubiera cache. */
const LIB_CACHE = "spitifo:library:v2";
const LIB_CACHE_OLD = "spitifo:library";
const readLibCache = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(LIB_CACHE));
    if (raw && Array.isArray(raw.rows)) {
      return expandCompactLibrary(raw.fields, raw.rows);
    }
  } catch {
    /* cache corrupta: se sigue sin ella, como si no existiera */
  }
  try {
    localStorage.removeItem(LIB_CACHE_OLD);
  } catch {
    /* no se puede limpiar: no es grave, solo queda un espejo viejo sin uso */
  }
  return null;
};
const writeLibCache = (fields, rows) => {
  try {
    localStorage.setItem(LIB_CACHE, JSON.stringify({ fields, rows }));
  } catch {
    /* lleno o bloqueado: la proxima apertura espera a la red, como antes */
  }
};

/* Inicio y Tu biblioteca son pantallas distintas con el mismo codigo: Vite
   emite un chunk compartido y cada una solo suma su pantalla. */
const loadHomeScreen = () => import("../listen/HomeScreen.jsx");
const loadLibraryScreen = () => import("../listen/LibraryScreen.jsx");
const loadSearchView = () => import("../download/SearchScreen.jsx");
/* Descubrir se guarda ya resuelto cuando su chunk llega (se adelanta con la app
   ociosa): si el usuario lo abre despues, la pantalla se pinta dentro de la
   transicion y no tras una pasada de Suspense. Mismo motivo que "Ahora suena". */
let ReadyDiscover = null;
const loadDiscoverView = () =>
  import("../discover/DiscoverView.jsx").then((m) => {
    ReadyDiscover = m.default;
    return m;
  });
const loadSettingsView = () => import("../settings/SettingsView.jsx");

/* "Ahora suena" no usa React.lazy: abrirla es una View Transition que pinta la
   vista dentro de flushSync, y un componente perezoso aun sin resolver
   suspenderia ese pintado y la foto nueva saldria vacia. Se espera al chunk
   antes de empezar y se guarda el componente en el modulo. */
let NowPlaying = null;
const loadNowPlaying = () =>
  import("../player/NowPlaying.jsx").then((m) => {
    NowPlaying = m.default;
  });

const HomeScreen = React.lazy(loadHomeScreen);
const LibraryScreen = React.lazy(loadLibraryScreen);
const SearchView = React.lazy(loadSearchView);
const LazyDiscover = React.lazy(loadDiscoverView);
function DiscoverView(props) {
  /* Se elige al montar y no cambia: cambiar de tipo desmontaria la pantalla. */
  const [View] = useState(() => ReadyDiscover ?? LazyDiscover);
  return <View {...props} />;
}
const SettingsView = React.lazy(loadSettingsView);
/* La pildora llega con el espejo de la cola, no con el shell: hasta que el
   usuario descarga algo o el sondeo de entrada encuentra trabajo, no se carga. */
const QueuePill = React.lazy(() => import("../download/QueuePill.jsx"));
/* Las paginas de la pila de Buscar (Explorar la biblioteca, «Ver las N canciones»). */
const SearchPage = React.lazy(() => import("../download/SearchPage.jsx"));
/* La hoja de Descargas comparte chunk con la ficha del album; se adelanta al
   enfocar la pildora o una tarjeta de album. */
const QueueSheet = React.lazy(() => loadAlbumChunk().then((m) => ({ default: m.QueueSheet })));
/* La ficha del album que abre una fila que falta en Escuchar. Buscar pinta la
   suya; esta sirve en cualquier pestana, como la hoja de Descargas. */
const ListenAlbumSheet = React.lazy(() => loadAlbumChunk().then((m) => ({ default: m.AlbumSheet })));

/* Mientras la pantalla esta oculta no se reconcilia su arbol: los cambios de
   pestana y de "Ahora suena" no recorren las cuatro pantallas que no se ven. Lo
   que cambia en contextos sigue llegando a sus consumidores. */
const Hold = memo(
  ({ children }) => children,
  (a, b) => a.hold && b.hold
);

/* Una pantalla sigue montada aunque no se vea: `hidden` la saca del layout y
   `inert` del foco, pero su estado (scroll, resultados, reproductores) queda.
   `data-seen` marca la que ya se mostro una vez: los fundidos de entrada de sus
   secciones solo corren la primera vez (volver ya entra con el de la pantalla). */
function Screen({ id, active, children }) {
  const [seen, setSeen] = useState(false);
  const shown = useRef(false);
  useEffect(() => {
    if (active) shown.current = true;
    else if (shown.current) setSeen(true);
  }, [active]);
  return (
    <section
      className="screen"
      data-screen={id}
      data-seen={seen ? "" : undefined}
      id={active ? "main-content" : undefined}
      tabIndex={active ? -1 : undefined}
      hidden={!active}
      inert={!active}
    >
      <Suspense fallback={null}>
        <Hold hold={!active}>{children}</Hold>
      </Suspense>
    </section>
  );
}

/* Adelanto del chunk que probablemente sigue. La pestana con la que arranca la
   app carga ya: no puede esperar a que este ociosa. */
const MODE_LOADERS = {
  home: loadHomeScreen,
  search: loadSearchView,
  library: loadLibraryScreen,
  discover: loadDiscoverView,
};
const bootView = readView(window.location.search);
MODE_LOADERS[bootView.tab]();

/* El mapa de generos se pide en el mismo gesto que abre Descubrir, en paralelo
   con su chunk, y nunca antes: ni al arrancar ni cuando la app esta ociosa. Si
   hay chunk (adelantado con la app ociosa) tambien se decodifica ya, para que la
   pantalla nazca con el mapa. Si la app abre ya en Descubrir (?view=discover),
   desde aca. */
function warmDiscover() {
  fetchMapFile().catch(() => {});
  loadDiscoverView().then(
    (m) => m.warmMap?.(),
    () => {}
  );
}
if (bootView.tab === "discover" && !bootView.settings) warmDiscover();

const typing = () =>
  isTypingTarget(document.activeElement?.tagName, document.activeElement?.isContentEditable);

/* Las teclas de toda la app, UNA vez.
   Escape, de lo mas pequeno a lo mas grande (gana el primero que actua):
   "Ahora suena" (a pantalla completa la cierra; ampliada en escritorio la
   reduce; la columna no se cierra con Escape), lo de arriba de la pila (un menu, una hoja, la pagina o
   Ajustes).
   "/" y Ctrl/Cmd+K llevan el foco al buscador de la pantalla a la vista o al
   de la barra de arriba. El ultimo no actua mientras se escribe en otro campo;
   desde el propio buscador solo selecciona su texto. */
function Hotkeys({ nav, escapeNp, npOpen, wide }) {
  useEffect(() => {
    /* El de la pantalla, si se ve (el de Buscar esta oculto en escritorio);
       si no, el de la barra de arriba. */
    const field = () =>
      (!wide &&
        [...document.querySelectorAll('[data-screen]:not([hidden]) [data-field="search"]')].find(
          (f) => f.getClientRects().length
        )) ||
      document.querySelector('.topbar [data-field="search"]');
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (escapeNp()) return;
        if (nav.getStack().length) nav.back();
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.defaultPrevented) {
        if (npOpen || typing()) return;
        const f = field();
        if (!f) return;
        e.preventDefault();
        f.focus();
      } else if (isSearchShortcut(e)) {
        if (npOpen) return;
        const f = field();
        if (!f) return;
        const at = document.activeElement;
        if (at !== f && typing()) return;
        e.preventDefault();
        if (at === f) f.select();
        else f.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [nav, escapeNp, npOpen, wide]);
  return null;
}

/* El espejo de la cola no sabe nada de React: App le da las dos funciones que
   necesita del exterior (refrescar la biblioteca y mostrar el aviso) en cuanto
   el modulo llega, aunque lo haya hecho despues de montarse. `onReady` enciende
   la pildora. El sondeo de entrada corre una vez, despues del primer pintado.
   Vive dentro del NoticeProvider para tener el `show` de la app. */
function QueueHooks({ onLibrary, onReady }) {
  const show = useShow();
  useEffect(() => {
    let store = null;
    const off = onQueueReady((mod) => {
      store = mod.queueStore;
      store.setHooks({ onLibrary, onToast: show });
      onReady();
    });
    return () => {
      off();
      store?.setHooks({});
    };
  }, [onLibrary, show, onReady]);
  useEffect(() => {
    probeQueue();
  }, []);
  return null;
}

export default function App() {
  const [health, setHealth] = useState(null);
  /* La pildora no se monta hasta que el espejo de la cola esta cargado. */
  const [queueReady, setQueueReady] = useState(false);
  const onQueueReadyPill = useCallback(() => setQueueReady(true), []);
  /* null = todavia no lo sabemos. Distinguir "vacia" de "sin consultar" importa:
     Inicio pinta esqueletos mientras llega y "Todavia no has descargado
     nada" solo cuando de verdad esta vacia. */
  const [lib, setLib] = useState(readLibCache);
  /* true = /api/library fallo y todavia no hay lista que mostrar. */
  const [libErr, setLibErr] = useState(false);
  /* Codigo del ultimo fallo: `reconnect_required` tiene su propia salida. */
  const [libErrCode, setLibErrCode] = useState(null);
  /* Espejo sincronico de `lib`: el borrado diferido necesita devolver EXACTAMENTE
     las filas que saco, aunque el deshacer llegue antes del siguiente render. */
  const libRef = useRef(lib);
  const pendingDeletes = useRef(null);
  if (pendingDeletes.current === null) pendingDeletes.current = createPendingDeletes();
  libRef.current = lib;

  const pc = usePc();
  const [phoneNav, setPhoneNav] = useState(readPhoneNav);
  const screensRef = useRef(null);

  /* "Ahora suena" abierta. Como Ajustes, abrirla empuja UNA entrada al
     historial para que el atras de Android y del navegador la cierren, y
     cerrarla (con la X, Escape o un arrastre) pide un retroceso y deja que
     popstate cierre de verdad. La maquina (npHistory.js) lleva npEntry
     (0 cerrada, 1 abierta, 2 cerrandose), la profundidad de la pila al abrir,
     si la salida anima y el `then` pendiente. El estado abierto/cerrado y la
     pestana viven en el almacen del panel. */
  const panelState = usePanel();
  const hasTrack = useEngine((s) => Boolean(s.track));
  const npRef = useRef(null);
  if (npRef.current === null) {
    /* La maquina recibe la interfaz minima (push, go, state), no el History del
       navegador: pushState necesita ademas la URL. */
    const browserHistory = {
      push: (state) => window.history.pushState(state, "", window.location.href),
      go: (n) => window.history.go(n),
      get state() {
        return window.history.state;
      },
    };
    npRef.current = createNpHistory({
      history: browserHistory,
      /* Unico efecto que la maquina no puede hacer por si sola: cerrar el
         panel. Con `then` se cierra dentro de flushSync para que la pantalla
         de destino ya este pintada cuando corra la navegacion. */
      closePanel: ({ then, morph, direct }) => {
        if (then) {
          flushSync(() => panel.close());
          then();
        } else if (!direct && morph) {
          swapNowPlaying(() => panel.close(), false);
        } else {
          panel.close();
        }
      },
    });
  }
  const npHistory = npRef.current;

  const loadHealth = useCallback(() => {
    fetch(`${API}/health`)
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);
  useEffect(loadHealth, [loadHealth]);

  /* Teclas multimedia, auriculares y pantalla de bloqueo. Se engancha UNA vez:
     el motor avisa de cada cambio de pista o de estado y mediaSession solo
     traduce. Sin la API, bindMediaSession devuelve un no-op. */
  useEffect(() => bindMediaSession(engine), []);

  /* El aviso del proximo stream se carga aparte: mientras suena musica de la
     biblioteca no hace falta ni el modulo ni ninguna peticion. */
  useEffect(() => {
    let off = () => {};
    let alive = true;
    import("../player/streamPrefetch.js").then(({ bindStreamPrefetch }) => {
      if (alive) off = bindStreamPrefetch(engine);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  /* El shell Android necesita ademas la notificacion del sistema. Se carga solo
     cuando el puente existe, asi el chunk del puente no sale en escritorio ni
     en el navegador; bindAndroidMedia traduce la misma foto del motor. */
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.SpitifoAndroid?.mediaUpdate !== "function"
    ) {
      return undefined;
    }
    let off = () => {};
    let alive = true;
    import("../player/androidMedia.js").then(({ bindAndroidMedia }) => {
      if (alive) off = bindAndroidMedia(engine);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  /* Historial de escucha: UNA vez por app. El tracker vive mientras App este
     montada y cierra la sesion abierta con "close" al desmontarse. */
  useEffect(() => {
    const tracker = createListenTracker(engine);
    return () => tracker.stop();
  }, []);

  /* Si el server no responde, el contador queda en null (consultando) en vez
     de romperse: el panel se abre vacio y el error se ve en la consola. */
  const loadLib = useCallback(async (opts) => {
    /* El registro de guardadas se pide junto con la biblioteca, pero NO se
       espera: una lista con Drive tarda y las filas de archivos tienen que
       pintarse igual. Se pide en cada recarga: una descarga terminada enlaza
       su archivo con la guardada en el servidor (el backend lo tiene en cache). */
    saved.load(true, (songs) => pendingDeletes.current.filterSaved(songs));
    /* Las fotos propias se piden con la biblioteca y las guardadas. */
    art.load(true);
    /* El borrado confirmado suelta sus claves antes de recargar: lo que no se
       pudo borrar tiene que volver a verse. `opts` puede ser un evento (onRetry). */
    if (Array.isArray(opts?.release)) pendingDeletes.current.release(opts.release);
    try {
      /* `shape=compact` pide las filas en columnas (libraryCompact.js): un
         backend viejo ignora el parametro desconocido y sigue mandando
         `files` como siempre (P-large-library-scale-1, -8). */
      const r = await fetch(`${API}/library?shape=compact`);
      if (!r.ok) {
        /* El 503 del token de la nube se distingue del resto: ahi lo que hay
           que hacer es reconectar, no reintentar (ADR 0002, seccion 8). */
        const d = await r.json().catch(() => ({}));
        setLibErr(true); // un 500 no puede pisar el contador
        setLibErrCode(d.code || null);
        return;
      }
      const d = await r.json();
      const fields = Array.isArray(d.fields) && d.fields.length ? d.fields : COMPACT_FIELDS;
      const files = Array.isArray(d.rows) ? expandCompactLibrary(fields, d.rows) : d.files || [];
      setLib(pendingDeletes.current.filter(files));
      /* Siempre se guarda compacto, aunque el backend haya mandado `files`
         (uno viejo que no entiende `shape=compact`): el espejo de
         localStorage no depende de la version del servidor. */
      writeLibCache(fields, Array.isArray(d.rows) ? d.rows : compactLibraryRows(files, fields));
      setLibErr(false);
      setLibErrCode(null);
      /* El borrado mira esta lista, sin filtrar, para saber que se fue de verdad. */
      return files;
    } catch (e) {
      setLibErr(true);
      setLibErrCode(null);
      /* ACA NO se toca `lib`. Setearlo a [] convierte "no se pudo consultar"
         en "biblioteca vacia", que es justo lo que `lib === null` servia para
         distinguir. Un 500 con 22 archivos en disco llegaba como "vacia". */
    }
  }, []);

  /* La notificacion (y Media Session) leen track.artwork del motor. Cuando
     cambia la foto de la pista que suena, o cambia de pista, se vuelve a
     resolver: asi el aviso sigue a la portada que se ve en pantalla. */
  useEffect(() => {
    const sync = () => {
      const t = engine.getState().track;
      if (!t) return;
      const target = songTarget({ sid: t.sid, key: t.key });
      const record = target ? art.getState().byTarget.get(target) : null;
      engine.setArtwork(record ? artSrc(record, keyUrl) : null);
    };
    const offArt = art.subscribe(sync);
    const offTrack = engine.onTrackEvent(sync);
    sync();
    return () => {
      offArt();
      offTrack();
    };
  }, []);

  /* Borrado diferido: la fila desaparece en el acto y vuelve si se deshace. El
     cache de arranque NO se toca: si la app se cierra antes del commit, el
     proximo /api/library la trae de vuelta. */
  const hideKeys = useCallback((keys) => {
    const gone = new Set(keys);
    const current = libRef.current || [];
    const removedFiles = current.filter((f) => gone.has(f.key));
    const removedSongs = [...saved.getState().byId.values()].filter((s) => gone.has(s.id));
    const next = current.filter((f) => !gone.has(f.key));
    /* Solo lo que estaba a la vista: es lo que restoreFiles va a soltar. */
    pendingDeletes.current.hide([
      ...removedFiles.map((f) => f.key),
      ...removedSongs.map((s) => s.id),
    ]);
    if (removedSongs.length) saved.hide(removedSongs.map((s) => s.id));
    libRef.current = next;
    setLib(next);
    /* Las guardadas vuelven con su registro en `song`, sin otra consulta. */
    return [...removedFiles, ...removedSongs.map((s) => ({ key: s.id, song: s }))];
  }, []);
  const restoreFiles = useCallback((removed) => {
    if (!removed?.length) return;
    pendingDeletes.current.release(removed.map((r) => r.key));
    const songs = removed.filter((r) => r.song).map((r) => r.song);
    if (songs.length) saved.restore(songs);
    const files = removed.filter((r) => !r.song);
    if (!files.length) return;
    const current = libRef.current || [];
    const have = new Set(current.map((f) => f.key));
    const next = [...current, ...files.filter((f) => !have.has(f.key))];
    libRef.current = next;
    setLib(next);
  }, []);

  /* Cambiar donde vive la biblioteca cambia lo que lista /api/library y la
     etiqueta de /api/health: las dos se recargan. */
  const onStorageChanged = useCallback(() => {
    loadHealth();
    loadLib();
  }, [loadHealth, loadLib]);

  /* --- "Ahora suena" -------------------------------------------------------- */

  /* Cambiar de pestana, abrir una pagina desde el menu o abrir Ajustes con
     "Ahora suena" abierta la cierra primero. Lo decide la maquina: devuelve
     true si se hizo cargo y `then` corre cuando el historial ya volvio. Si hay
     hojas encima, salen TODAS en un solo go(-n); un back suelto aterrizaria en
     la entrada muerta de la vista, sin panel que la cierre. */
  const leaveNp = useCallback((then) => npHistory.leave(then), [npHistory]);

  /* --- Navegacion: pestanas, Ajustes y la pila de paginas ------------------- */

  /* Contador que sube en cada popstate y en cada navegacion. Las acciones
     asincronas guardan el token al empezar y solo actuan si sigue igual: si el
     usuario retrocede o cierra el reproductor mientras esperan, se descartan. */
  const navGen = useRef(0);
  const bumpNav = useCallback(() => {
    navGen.current += 1;
  }, []);

  const nav = useNavController({
    leaveNp,
    warm: (tab) => tab === "discover" && warmDiscover(),
    onNavigate: bumpNav,
  });
  const locationRef = useRef(null);
  if (locationRef.current === null) {
    locationRef.current = createLocationToken({ getStack: nav.getStack, np: npHistory, gen: navGen });
  }
  const locationToken = locationRef.current;

  /* Telefono: pantalla completa ("full"). Escritorio: una columna al lado de
     las paginas ("docked"; flotando sobre Descubrir, "over"; ampliada, "wide"),
     sin historial: no es navegacion, el atras no la cierra. */
  const { activeId, visited } = nav;
  const viewId = viewKey(nav.tab, nav.stack);
  const mode = panelMode(panelState, {
    key: viewId,
    discover: activeId === "discover",
    pc,
    track: hasTrack,
  });
  const full = mode === "full";
  const np = mode !== "off";
  const wide = mode === "wide";

  /* La columna sabe en que vista se abrio o se amplio: al cambiar de vista, la
     ampliada vuelve a columna y lo abierto en Descubrir deja de flotar. */
  useEffect(() => {
    if (!panelState.open || panelState.at === viewId) return;
    if (panelState.wide) panel.collapse();
    else if (panelState.at === "discover") panel.show(panelState.tab, viewId);
  }, [panelState, viewId]);

  /* El CSS aparta las paginas segun el estado de la columna (shell.css). */
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (pc && mode !== "off" && mode !== "full") root.dataset.rp = mode;
    else delete root.dataset.rp;
    return () => {
      delete root.dataset.rp;
    };
  }, [pc, mode]);

  /* `toggle` (Cola y Ficha de la barra): pulsar la pestana que se ve cierra. */
  const openNp = useCallback((page = 0, toggle = false) => {
    if (!engine.getState().track) return;
    /* "Cola" y "Ficha" de la barra abren su pestana. */
    const tab = page === 1 ? 1 : page === 2 ? 2 : 0;
    if (isPc()) {
      if (toggle && np && panel.get().tab === tab) {
        panel.close();
        return;
      }
      loadNowPlaying()
        .then(() => panel.show(tab, nav.getKey()))
        .catch(() => {});
      return;
    }
    if (!npHistory.open(nav.getStack().length)) return;
    loadNowPlaying()
      .then(() => {
        npHistory.pushNp();
        swapNowPlaying(() => panel.show(tab, nav.getKey()), true);
      })
      .catch(() => npHistory.cancelOpen());
  }, [npHistory, nav.getStack, nav.getKey, np]);

  const closeNp = useCallback((morph = true) => npHistory.close(morph), [npHistory]);

  /* «Cerrar reproductor» del menu de "Ahora suena": la hoja que hubiera encima
     y la entrada de la vista salen en un solo go. La maquina marca el retroceso
     en vuelo, descarta cualquier `then` pendiente e ignora un segundo tap. En
     escritorio (sin entrada) el menu se cierra con nav.back. */
  const closeFromMenu = useCallback(() => {
    closeDock();
    if (npHistory.closeFromMenu() === "desktop") nav.back();
  }, [npHistory, nav.back]);

  useEffect(() => {
    registerClosePlayer(closeFromMenu);
    return () => registerClosePlayer(null);
  }, [closeFromMenu]);

  /* Escape: lo mas pequeno primero. Con un menu abierto encima de "Ahora
     suena" se cierra ese; la segunda pulsacion cierra la vista. */
  const escapeNp = useCallback(() => {
    const above = npHistory.entry ? aboveNp(nav.getStack(), npHistory.depth) : false;
    const handled = npHistory.escape(above);
    if (handled === "overlay") {
      nav.back();
      return true;
    }
    if (handled) return true;
    /* Escritorio: Escape reduce la ampliada y no cierra nada mas. */
    if (panel.get().wide) {
      panel.collapse();
      return true;
    }
    return false;
  }, [npHistory, nav.back, nav.getStack]);

  const onWide = useCallback(
    (on) => (on ? panel.expand(nav.getKey()) : panel.collapse()),
    [nav.getKey]
  );

  /* El atras (o el cierre) de "Ahora suena". Va DESPUES del popstate de
     useNav para que este ya haya sincronizado la pila cuando corre `then`.
     La decision (seguir abierta si aterrizamos en su entrada, cerrar y correr
     `then` si bajamos) vive en la maquina; aqui solo se registra el oyente. */
  useEffect(() => {
    window.addEventListener("popstate", npHistory.onPop);
    return () => window.removeEventListener("popstate", npHistory.onPop);
  }, [npHistory]);

  /* Todo popstate deja sin efecto a las navegaciones asincronas en vuelo. */
  useEffect(() => {
    window.addEventListener("popstate", bumpNav);
    return () => window.removeEventListener("popstate", bumpNav);
  }, [bumpNav]);

  /* Al cerrarla el foco vuelve a la pastilla, de donde se abrio. */
  const wasNp = useRef(false);
  useLayoutEffect(() => {
    if (wasNp.current && !np) {
      document.querySelector(".mini__txt, .lcd__cv")?.focus({ preventScroll: true });
    }
    wasNp.current = np;
  }, [np]);

  /* La barra inferior cambia de alto segun la preferencia; el CSS lo lee de
     --nav-h (body.nav-swipe). */
  useEffect(() => {
    document.body.classList.toggle("nav-swipe", phoneNav === "swipe");
    return () => document.body.classList.remove("nav-swipe");
  }, [phoneNav]);

  const changePhoneNav = useCallback((value) => {
    writePhoneNav(value);
    setPhoneNav(value);
  }, []);

  /* Swipe entre pestanas: solo en telefono, con la barra de puntos, en la raiz
     de la pestana (con una pagina abierta el gesto es de la pagina y soltaria
     la pila) y con Ajustes cerrado. El gesto no puede nacer en una zona con su
     propio arrastre horizontal (progreso, video, menus). */
  const { tab, goTab } = nav;
  const canSwipe = phoneNav === "swipe" && nav.stack.length === 0;
  useEffect(() => {
    if (!canSwipe) return undefined;
    const root = screensRef.current;
    if (!root) return undefined;
    let start = null;

    const onStart = (e) => {
      if (isPc() || e.touches.length !== 1) {
        start = null;
        return;
      }
      if (!canStartSwipe(e.target)) {
        start = null;
        return;
      }
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, time: performance.now() };
    };

    const onEnd = (e) => {
      if (!start) return;
      const from = start;
      start = null;
      const t = e.changedTouches?.[0];
      if (!t) return;
      const next = swipeTarget(
        { dx: t.clientX - from.x, dy: t.clientY - from.y, dt: performance.now() - from.time },
        TABS.indexOf(tab),
        TABS.length
      );
      if (next !== null) goTab(TABS[next]);
    };

    const onCancel = () => {
      start = null;
    };

    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchend", onEnd, { passive: true });
    root.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onCancel);
    };
  }, [canSwipe, tab, goTab]);

  /* Adelanto del chunk de la pestana vecina, de Ajustes y de Descubrir cuando
     la app esta ociosa (y no antes, para no competir con la primera pintura).
     El de Descubrir va desde cualquier pestana: es el unico que trae un mapa
     que dibujar y cada milisegundo de su primera visita se nota. Solo el chunk:
     su mapa (genre-map.json) espera a que el usuario abra Descubrir. Se repite
     al cambiar de pestana: la siguiente pantalla probable cambia. */
  useEffect(() => {
    const preload = () => {
      loadSettingsView();
      loadNowPlaying();
      loadPageHost();
      loadOverlays();
      MODE_LOADERS[nextGuess(tab)]?.();
      loadDiscoverView();
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(preload);
      return () => window.cancelIdleCallback?.(id);
    }
    const id = setTimeout(preload, 1500);
    return () => clearTimeout(id);
  }, [tab]);

  /* Saltar a una cancion desde "Ahora suena": se abre Todas tus canciones
     (una pagina de Tu biblioteca) con la fila centrada. */
  const revealSong = useCallback(
    (key) => {
      requestReveal(key);
      nav.goTo("library", { type: "library", sort: "recent" });
    },
    [nav.goTo]
  );

  /* "Ver mas" de Buscar: Explorar la biblioteca, lo ultimo que llego primero. */
  const openLibrary = useCallback(
    () => nav.open({ type: "library", sort: "recent" }),
    [nav.open]
  );

  /* "Ver en tu biblioteca" de "Ahora suena": primero se cierra la vista y
     despues se salta a la fila. */
  const revealFromNp = useCallback(
    (key) => {
      /* La columna de escritorio no tiene entrada que cerrar: se salta ya. */
      if (!leaveNp(() => revealSong(key))) revealSong(key);
    },
    [leaveNp, revealSong]
  );

  /* El artista o el album de "Ahora suena" (npLinks.js): primero se cierra la
     vista y despues se abre la pagina, como "Ver en tu biblioteca". */
  const goFromNp = useCallback(
    (link) => {
      const go = async () => {
        if (link.sheet) {
          loadAlbumChunk();
          nav.open(link.sheet);
          return;
        }
        if (link.view) {
          if (link.view.type === "itunesartist") loadArtistChunk();
          nav.goTo(link.tab, link.view);
          return;
        }
        loadArtistChunk();
        /* Solo hace falta aqui: no entra en el primer script. */
        const { resolveArtistLink } = await import("../download/artistLink.js");
        const view = await resolveArtistLink(link.name, []);
        if (view) nav.goTo("search", view);
        else {
          requestSearch(link.name);
          nav.goTab("search");
        }
      };
      if (!leaveNp(go)) go();
    },
    [leaveNp, nav.open, nav.goTo, nav.goTab]
  );

  /* /api/library se pide al montar y no solo al abrir una pantalla: es una lista
     de archivos locales (no toca red) y asi las pantallas ya la tienen. */
  useEffect(() => {
    loadLib();
  }, [loadLib]);

  /* null = la consulta sigue en vuelo. Sin esta distincion Inicio mostraria
     "vacia" mientras todavia pregunta. */
  const libFiles = useMemo(() => lib || [], [lib]);
  const libReady = lib !== null;
  const storage = /^Google Drive/.test(health?.library) ? "Google Drive" : "este dispositivo";

  const searchPage = nav.pageOf("search");

  /* La hoja de Descargas es una entrada mas de la pila: atras, Escape y el
     atras de Android la cierran, y el foco vuelve a la pildora. */
  const queueAt = nav.stack.at(-1)?.type === "descargas" ? nav.stack.at(-1) : null;
  const openQueue = useCallback((anchor) => nav.open({ type: "descargas", anchor }), [nav.open]);
  const topEntry = nav.stack.at(-1);
  const listenAlbumAt = topEntry?.type === "albumsheet" && topEntry.from === "listen" ? topEntry : null;

  return (
    <NavContext.Provider value={nav}>
      {/* El proveedor de la biblioteca rodea las pantallas Y "Ahora suena" (los
          mosaicos de su hoja de listas); no pinta DOM propio. */}
      <ListenProvider
        files={libFiles}
        nav={nav}
        leaveNp={leaveNp}
        locationToken={locationToken}
        storage={storage}
        refresh={loadLib}
        hideKeys={hideKeys}
        restoreFiles={restoreFiles}
      >
        <QueueHooks onLibrary={loadLib} onReady={onQueueReadyPill} />
        <StreamErrors />
        <main className="app" inert={full}>
          {/* Un solo juego de chrome a la vez: el menu lateral y la barra de
              arriba en escritorio; la barra inferior y la pastilla, en telefono. */}
          {pc && (
            <>
              <LeftNav />
              <TopBar />
            </>
          )}

          <Hotkeys nav={nav} escapeNp={escapeNp} npOpen={full} wide={wide} />
          <div className="screens" ref={screensRef} inert={wide}>
            {visited.has("home") && (
              <Screen id="home" active={activeId === "home"}>
                <HomeScreen
                  ready={libReady}
                  error={libErr}
                  errorCode={libErrCode}
                  active={activeId === "home"}
                  onRetry={loadLib}
                  storagePath={health?.library}
                />
              </Screen>
            )}

            {visited.has("search") && (
              <Screen id="search" active={activeId === "search"}>
                {/* Con una pagina abierta (Explorar la biblioteca) Buscar se
                    esconde pero sigue montada: conserva resultados y
                    descargas. */}
                <div hidden={searchPage ? true : undefined}>
                  <SearchView
                    active={activeId === "search"}
                    health={health}
                    files={libFiles}
                    onLibraryChanged={loadLib}
                    onImportCookies={() => nav.openSettings("cookies")}
                    onOpenLibrary={openLibrary}
                  />
                </div>
                {searchPage && (
                  <Suspense fallback={null}>
                    <SearchPage view={searchPage} active={activeId === "search"} />
                  </Suspense>
                )}
              </Screen>
            )}

            {visited.has("library") && (
              <Screen id="library" active={activeId === "library"}>
                <LibraryScreen
                  ready={libReady}
                  error={libErr}
                  errorCode={libErrCode}
                  active={activeId === "library"}
                  onRetry={loadLib}
                />
              </Screen>
            )}

            {visited.has("discover") && (
              <Screen id="discover" active={activeId === "discover"}>
                <DiscoverView
                  active={activeId === "discover"}
                  onOpenDownload={() => nav.goTab("search")}
                />
              </Screen>
            )}

            {visited.has("settings") && (
              <Screen id="settings" active={activeId === "settings"}>
                <SettingsView
                  active={activeId === "settings"}
                  focus={nav.settings?.focus ?? null}
                  onClose={nav.back}
                  onChanged={onStorageChanged}
                  phoneNav={phoneNav}
                  onPhoneNav={changePhoneNav}
                />
              </Screen>
            )}
          </div>

          {/* Sobre el reproductor, en cualquier modo: la cola sigue contando
              aunque Buscar este oculta. Solo se monta cuando el espejo llega. */}
          {queueReady && (
            <Suspense fallback={null}>
              <QueuePill onOpen={openQueue} />
            </Suspense>
          )}

          {/* Fuera de las pantallas: Buscar puede estar oculta con la descarga en
              marcha. En escritorio las tarjetas van en el menu lateral. */}
          {pc ? <PlayerBar onOpen={openNp} npOpen={false} tab={np ? panelState.tab : -1} /> : (
            <>
              <ProgressStack />
              <MiniPlayer onOpen={openNp} npOpen={full} />
            </>
          )}
          {/* Montado una sola vez: es el dueno del <video> y por eso la
              reproduccion no se corta al cambiar de pestana. */}
          <VideoHost />

          {!pc &&
            (phoneNav === "tabs" ? (
              <TabBar tab={nav.tab} onTab={nav.goTab} />
            ) : (
              <SwipeDots tab={nav.tab} onTab={nav.goTab} />
            ))}
        </main>
        {/* Fuera de <main>: este se vuelve inerte mientras la vista esta a pantalla
            completa. */}
        {np && NowPlaying && (
            <NowPlaying mode={mode} onClose={closeNp} onReveal={revealFromNp} onWide={onWide} onGo={goFromNp} />
          )}
        {queueAt && (
          <Suspense fallback={null}>
            <QueueSheet anchor={queueAt.anchor} onClose={nav.back} />
          </Suspense>
        )}
        {listenAlbumAt?.album && (
          <Suspense fallback={null}>
            <ListenAlbumSheet
              key={`a${listenAlbumAt.id}`}
              album={listenAlbumAt.album}
              anchor={listenAlbumAt.anchor}
              onClose={nav.back}
            />
          </Suspense>
        )}
      </ListenProvider>
    </NavContext.Provider>
  );
}
