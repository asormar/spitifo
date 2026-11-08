import React, { Suspense, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { API } from "../shared/api.js";
import MiniPlayer from "../player/MiniPlayer.jsx";
import PlayerBar from "../player/PlayerBar.jsx";
import VideoHost from "../player/VideoHost.jsx";
import { engine } from "../player/engine.js";
import { createListenTracker } from "../player/listens.js";
import { bindMediaSession } from "../player/mediaSession.js";
import { fetchMapFile } from "../discover/mapFile.js";
import { requestReveal } from "../listen/revealRequest.js";
import ListenProvider, { useListen } from "../listen/ListenProvider.jsx";
import { loadPageHost } from "../listen/pageLoader.jsx";
import { ProgressStack } from "../download/progress.jsx";
import {
  TABS,
  canStartSwipe,
  nextGuess,
  readPhoneNav,
  readView,
  swipeTarget,
  writePhoneNav,
} from "./navigation.js";
import useNavController, { NavContext } from "./useNav.js";
import { SwipeDots, TabBar } from "./Nav.jsx";
import LeftNav from "./LeftNav.jsx";
import TopBar from "./TopBar.jsx";
import { isPc, usePc } from "../shared/viewport.js";
import { swapNowPlaying } from "./screenSwap.js";

/* Ultima biblioteca que respondio el servidor, guardada en el dispositivo.
   Con Drive la lista tarda segundos en llegar (es red): mientras tanto
   Inicio y Tu biblioteca pintan la de la vez anterior y la real la reemplaza
   al llegar. Si el almacenamiento no deja leer o escribir, se sigue sin ella. */
const LIB_CACHE = "spitifo:library";
const readLibCache = () => {
  try {
    const files = JSON.parse(localStorage.getItem(LIB_CACHE));
    return Array.isArray(files) ? files : null;
  } catch {
    return null;
  }
};
const writeLibCache = (files) => {
  try {
    localStorage.setItem(LIB_CACHE, JSON.stringify(files));
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
/* Las paginas de la pila de Buscar (Explorar la biblioteca, «Ver las N canciones»). */
const SearchPage = React.lazy(() => import("../download/SearchPage.jsx"));

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
      hidden={!active}
      inert={active ? undefined : ""}
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

const typing = () => {
  const a = document.activeElement;
  return a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
};

/* Las dos teclas de toda la app, UNA vez. Va dentro del provider de la
   biblioteca: Escape tambien cierra su menu de fila.
   Escape, de lo mas pequeno a lo mas grande (gana el primero que actua):
   "Ahora suena", el menu de fila, la pagina de arriba (o Ajustes).
   "/" lleva el foco al buscador de la pantalla a la vista o al de la barra
   de arriba. */
function Hotkeys({ nav, escapeNp, npOpen }) {
  const { ctx } = useListen();
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (escapeNp()) return;
        if (ctx.closeTop()) return;
        if (nav.getStack().length) nav.back();
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.defaultPrevented) {
        if (npOpen || typing()) return;
        /* El de la pantalla, si se ve (el de Buscar esta oculto en escritorio);
           si no, el de la barra de arriba. */
        const field =
          [...document.querySelectorAll('[data-screen]:not([hidden]) [data-field="search"]')].find(
            (f) => f.getClientRects().length
          ) || document.querySelector('.topbar [data-field="search"]');
        if (!field) return;
        e.preventDefault();
        field.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [nav, ctx, escapeNp, npOpen]);
  return null;
}

export default function App() {
  const [health, setHealth] = useState(null);
  /* null = todavia no lo sabemos. Distinguir "vacia" de "sin consultar" importa:
     Inicio pinta esqueletos mientras llega y "Todavia no has descargado
     nada" solo cuando de verdad esta vacia. */
  const [lib, setLib] = useState(readLibCache);
  /* true = /api/library fallo y todavia no hay lista que mostrar. */
  const [libErr, setLibErr] = useState(false);
  /* Codigo del ultimo fallo: `reconnect_required` tiene su propia salida. */
  const [libErrCode, setLibErrCode] = useState(null);

  const pc = usePc();
  const [phoneNav, setPhoneNav] = useState(readPhoneNav);
  const screensRef = useRef(null);

  /* "Ahora suena" abierta. Como Ajustes, abrirla empuja UNA entrada al
     historial para que el atras de Android y del navegador la cierren, y
     cerrarla (con la X, Escape o un arrastre) hace history.back() y deja que
     popstate cierre de verdad. npEntry: 0 cerrada, 1 abierta, 2 cerrandose
     (ya se pidio el back; un segundo cierre no puede dar otro). */
  const [np, setNp] = useState(false);
  const npEntry = useRef(0);
  /* Pagina con la que abre: la cola si viene de "Cola" de la barra. */
  const npPage = useRef(0);
  /* Si el cierre es la animacion de vuelta a la pastilla o sin ella (el
     arrastre ya la saco de pantalla). */
  const npMorph = useRef(true);
  /* Lo que se hace al terminar de cerrarla: cambiar de pestana, abrir Ajustes. */
  const npThen = useRef(null);

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

  /* Historial de escucha: UNA vez por app. El tracker vive mientras App este
     montada y cierra la sesion abierta con "close" al desmontarse. */
  useEffect(() => {
    const tracker = createListenTracker(engine);
    return () => tracker.stop();
  }, []);

  /* Si el server no responde, el contador queda en null (consultando) en vez
     de romperse: el panel se abre vacio y el error se ve en la consola. */
  const loadLib = useCallback(async () => {
    try {
      const r = await fetch(`${API}/library`);
      if (!r.ok) {
        /* El 503 del token de la nube se distingue del resto: ahi lo que hay
           que hacer es reconectar, no reintentar (ADR 0002, seccion 8). */
        const d = await r.json().catch(() => ({}));
        setLibErr(true); // un 500 no puede pisar el contador
        setLibErrCode(d.code || null);
        return;
      }
      const d = await r.json();
      setLib(d.files || []);
      writeLibCache(d.files || []);
      setLibErr(false);
      setLibErrCode(null);
    } catch (e) {
      setLibErr(true);
      setLibErrCode(null);
      /* ACA NO se toca `lib`. Setearlo a [] convierte "no se pudo consultar"
         en "biblioteca vacia", que es justo lo que `lib === null` servia para
         distinguir. Un 500 con 22 archivos en disco llegaba como "vacia". */
    }
  }, []);

  /* Cambiar donde vive la biblioteca cambia lo que lista /api/library y la
     etiqueta de /api/health: las dos se recargan. */
  const onStorageChanged = useCallback(() => {
    loadHealth();
    loadLib();
  }, [loadHealth, loadLib]);

  /* --- "Ahora suena" -------------------------------------------------------- */

  /* Cambiar de pestana o abrir Ajustes con "Ahora suena" abierta la cierra
     primero. Devuelve true si se hizo cargo: `then` corre cuando el historial
     ya volvio a la entrada de debajo, asi no queda una entrada muerta. */
  const leaveNp = useCallback((then) => {
    if (!npEntry.current) return false;
    npThen.current = then;
    if (npEntry.current === 1) {
      npEntry.current = 2;
      window.history.back();
    }
    return true;
  }, []);

  /* --- Navegacion: pestanas, Ajustes y la pila de paginas ------------------- */

  const nav = useNavController({
    leaveNp,
    warm: (tab) => tab === "discover" && warmDiscover(),
  });

  const openNp = useCallback((page) => {
    if (npEntry.current || !engine.getState().track) return;
    npEntry.current = 1;
    npPage.current = page === 1 ? 1 : 0;
    loadNowPlaying()
      .then(() => {
        window.history.pushState({ spitifo: "np" }, "", window.location.href);
        swapNowPlaying(() => setNp(true), true);
      })
      .catch(() => {
        npEntry.current = 0;
      });
  }, []);

  const closeNp = useCallback((morph = true) => {
    if (npEntry.current !== 1) return;
    npEntry.current = 2;
    npMorph.current = morph;
    window.history.back();
  }, []);

  /* Escape: cierra "Ahora suena" si esta abierta. */
  const escapeNp = useCallback(() => {
    if (!npEntry.current) return false;
    closeNp();
    return true;
  }, [closeNp]);

  /* El atras (o el cierre) de "Ahora suena". Va DESPUES del popstate de
     useNav para que este ya haya sincronizado la pila cuando corre `then`. */
  useEffect(() => {
    const onNpPop = () => {
      if (!npEntry.current) return;
      npEntry.current = 0;
      const then = npThen.current;
      const morph = npMorph.current;
      npThen.current = null;
      npMorph.current = true;
      if (then) {
        flushSync(() => setNp(false));
        then();
      } else if (morph) {
        swapNowPlaying(() => setNp(false), false);
      } else {
        setNp(false);
      }
    };
    window.addEventListener("popstate", onNpPop);
    return () => window.removeEventListener("popstate", onNpPop);
  }, []);

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
      leaveNp(() => revealSong(key));
    },
    [leaveNp, revealSong]
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

  const { activeId, visited } = nav;
  const searchPage = nav.pageOf("search");

  return (
    <NavContext.Provider value={nav}>
      <main className="app" inert={np ? "" : undefined}>
        {/* Un solo juego de chrome a la vez: el menu lateral y la barra de
            arriba en escritorio; la barra inferior y la pastilla, en telefono. */}
        {pc && (
          <>
            <LeftNav npOpen={np} />
            <TopBar />
          </>
        )}

        <ListenProvider files={libFiles} nav={nav} storage={storage}>
          <Hotkeys nav={nav} escapeNp={escapeNp} npOpen={np} />
          <div className="screens" ref={screensRef}>
            {visited.has("home") && (
              <Screen id="home" active={activeId === "home"}>
                <HomeScreen
                  ready={libReady}
                  error={libErr}
                  errorCode={libErrCode}
                  active={activeId === "home"}
                  onRetry={loadLib}
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
        </ListenProvider>

        {/* Fuera de las pantallas: Buscar puede estar oculta con la descarga en
            marcha. En escritorio las tarjetas van en el menu lateral. */}
        {pc ? <PlayerBar onOpen={openNp} npOpen={np} /> : (
          <>
            <ProgressStack />
            <MiniPlayer onOpen={openNp} npOpen={np} />
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
      {/* Fuera de <main>: este se vuelve inerte mientras la vista esta abierta. */}
      {np && NowPlaying && (
        <NowPlaying onClose={closeNp} onReveal={revealFromNp} initialPage={npPage.current} />
      )}
    </NavContext.Provider>
  );
}
