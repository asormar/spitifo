import React, { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Moon, Sun, Waveform } from "@phosphor-icons/react";
import { API } from "../shared/api.js";
import { cx } from "../shared/ui.jsx";
import { useTheme } from "../shared/theme.js";
import MiniPlayer from "../player/MiniPlayer.jsx";
import VideoHost from "../player/VideoHost.jsx";
import { engine } from "../player/engine.js";
import { requestReveal } from "../listen/reveal.js";
import { bindMediaSession } from "../player/mediaSession.js";
import {
  MODES,
  canStartSwipe,
  modeDirection,
  nextGuess,
  readPhoneNav,
  readView,
  swipeTarget,
  writePhoneNav,
  writeView,
} from "./navigation.js";
import { Rail, SwipeDots, TabBar } from "./Nav.jsx";
import { swapScreens } from "./screenSwap.js";
import { NavIcon } from "./navIcons.jsx";

/* writeView devuelve "" para Descargar sin otros parametros, y pushState/
   replaceState con "" no cambian la URL: se cae al pathname. */
const viewUrl = (view) => writeView(window.location.search, view) || window.location.pathname;

const loadDownloadView = () => import("../download/DownloadView.jsx");
const loadListenView = () => import("../listen/ListenView.jsx");
const loadDiscoverView = () => import("../discover/DiscoverView.jsx");
const loadSettingsView = () => import("../settings/SettingsView.jsx");

const DownloadView = React.lazy(loadDownloadView);
const ListenView = React.lazy(loadListenView);
const DiscoverView = React.lazy(loadDiscoverView);
const SettingsView = React.lazy(loadSettingsView);

/* Una pantalla sigue montada aunque no se vea: `hidden` la saca del layout y
   `inert` del foco, pero su estado (scroll, resultados, reproductores) queda. */
function Screen({ id, active, children }) {
  return (
    <section
      className="screen"
      data-screen={id}
      hidden={!active}
      inert={active ? undefined : ""}
    >
      <Suspense fallback={null}>{children}</Suspense>
    </section>
  );
}

/* Adelanto del chunk que probablemente sigue. Descargar arranca ya: es el modo
   inicial y no puede esperar a que la app este ociosa. */
const MODE_LOADERS = {
  download: loadDownloadView,
  listen: loadListenView,
  discover: loadDiscoverView,
};
loadDownloadView();

export default function App() {
  /* La URL manda en el arranque: ?view=listen abre Escuchar y ?view=settings
     abre Ajustes. El resto de la app no cambia de modo sin pasar por aca. */
  const [boot] = useState(() => readView(window.location.search));

  const [health, setHealth] = useState(null);
  /* null = todavia no lo sabemos. Distinguir "vacia" de "sin consultar" importa:
     Escuchar pinta esqueletos mientras llega y "Todavia no has descargado
     nada" solo cuando de verdad esta vacia. */
  const [lib, setLib] = useState(null);
  /* true = /api/library fallo y todavia no hay lista que mostrar. */
  const [libErr, setLibErr] = useState(false);
  /* Codigo del ultimo fallo: `reconnect_required` tiene su propia salida. */
  const [libErrCode, setLibErrCode] = useState(null);

  const [theme, chooseTheme] = useTheme();
  const dark = theme === "dark";

  const [mode, setMode] = useState(boot.mode);
  /* `focus` elige la seccion que se trae a la vista al abrir Ajustes; null
     (el engranaje, el atras, la URL) la abre por arriba. */
  const [settings, setSettings] = useState(() =>
    boot.settings ? { open: true, focus: null } : { open: false, focus: null }
  );
  /* Pantallas montadas. La primera vez que una se activa se suma y ya no se
     desmonta: volver a un modo conserva scroll, resultados y reproductores. */
  const [visited, setVisited] = useState(
    () => new Set(boot.settings ? ["settings"] : [boot.mode])
  );
  const [phoneNav, setPhoneNav] = useState(readPhoneNav);

  const activeId = settings.open ? "settings" : mode;
  const scrollByScreen = useRef(new Map());
  const activeIdRef = useRef(activeId);
  /* true = la entrada actual del historial la creamos nosotros al abrir
     Ajustes. Cerrar entonces hace history.back() y deja que popstate sincronice
     (que es lo mismo que hace el boton atras de Android). */
  const settingsEntry = useRef(false);
  /* Modo pedido mientras se cerraba Ajustes con history.back(): popstate lo
     aplica cuando la entrada vieja ya esta activa. */
  const pendingMode = useRef(null);
  const screensRef = useRef(null);

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

  /* --- Shell: modos, Ajustes e historial ---------------------------------- */

  const rememberScroll = useCallback(() => {
    scrollByScreen.current.set(activeIdRef.current, window.scrollY);
  }, []);

  const visit = useCallback((id) => {
    setVisited((cur) => (cur.has(id) ? cur : new Set(cur).add(id)));
  }, []);

  const goMode = useCallback(
    (m) => {
      if (!MODES.includes(m)) return;
      rememberScroll();
      const from = activeIdRef.current;
      /* Con Ajustes abierto y entrada propia en el historial, el modo lo aplica
         popstate: animar aca y alla dejaria dos transiciones. */
      if (from === "settings" && settingsEntry.current) {
        settingsEntry.current = false;
        pendingMode.current = m;
        window.history.back();
        return;
      }
      const update = () => {
        setSettings({ open: false, focus: null });
        setMode(m);
        visit(m);
      };
      /* Tocar el modo que ya se ve no cambia de pantalla: sin transicion. */
      if (from === m) update();
      else swapScreens(update, modeDirection(from, m));
      window.history.replaceState(
        null,
        "",
        viewUrl({ mode: m, settings: false })
      );
    },
    [rememberScroll, visit]
  );

  const openSettings = useCallback(
    (focus = "storage") => {
      rememberScroll();
      swapScreens(() => {
        setSettings({ open: true, focus });
        visit("settings");
      }, 0);
      if (!settingsEntry.current) {
        window.history.pushState(
          { spitifo: "settings" },
          "",
          viewUrl({ mode, settings: true })
        );
        settingsEntry.current = true;
      }
    },
    [mode, rememberScroll, visit]
  );

  const closeSettings = useCallback(() => {
    rememberScroll();
    if (settingsEntry.current) {
      settingsEntry.current = false;
      window.history.back();
      return;
    }
    swapScreens(() => {
      setSettings({ open: false, focus: null });
      visit(mode);
    }, 0);
    window.history.replaceState(
      null,
      "",
      viewUrl({ mode, settings: false })
    );
  }, [mode, rememberScroll, visit]);

  const toggleSettings = useCallback(() => {
    if (settings.open) closeSettings();
    else openSettings(null);
  }, [settings.open, closeSettings, openSettings]);

  /* Un solo camino para el atras del navegador y el de Android: se relee la URL
     y se sincroniza el estado. Si venimos de un goMode con Ajustes abierto, el
     modo elegido gana y la entrada se reescribe. */
  useEffect(() => {
    const onPop = () => {
      rememberScroll();
      const view = readView(window.location.search);
      const pending = pendingMode.current;
      pendingMode.current = null;
      settingsEntry.current = pending ? false : view.settings;
      const nextMode = pending || view.mode;
      const nextSettings = view.settings && !pending;
      const nextActive = nextSettings ? "settings" : nextMode;
      const from = activeIdRef.current;
      const update = () => {
        setMode(nextMode);
        setSettings({ open: nextSettings, focus: null });
        visit(nextMode);
      };
      /* Si la pantalla visible no cambia (el modo ya lo aplico goMode), una
         transicion sobre la misma foto se veria como un doble deslizamiento. */
      if (nextActive === from) update();
      else swapScreens(update, pending ? modeDirection(from, nextMode) : 0);
      if (pending) {
        window.history.replaceState(
          null,
          "",
          viewUrl({ mode: pending, settings: false })
        );
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [rememberScroll, visit]);

  /* Al cambiar de pantalla se guarda el scroll de la que sale (lo hace cada
     transicion, antes de tocar el estado) y se restaura el de la que entra. Va
     en layout effect para que no se vea el salto de un fotograma; swapScreens
     lo corre dentro de flushSync, asi la foto de la View Transition ya sale
     con el scroll bueno. */
  useLayoutEffect(() => {
    const prev = activeIdRef.current;
    if (prev === activeId) return;
    activeIdRef.current = activeId;
    window.scrollTo(0, scrollByScreen.current.get(activeId) ?? 0);
  }, [activeId]);

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

  /* Swipe entre modos: solo en telefono, con la barra de puntos y Ajustes
     cerrado. El gesto no puede nacer en una zona con su propio arrastre
     horizontal (progreso, video, menus). */
  useEffect(() => {
    if (phoneNav !== "swipe" || settings.open) return undefined;
    const root = screensRef.current;
    if (!root) return undefined;
    let start = null;

    const onStart = (e) => {
      if (window.innerWidth >= 720 || e.touches.length !== 1) {
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
        MODES.indexOf(mode),
        MODES.length
      );
      if (next !== null) goMode(MODES[next]);
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
  }, [phoneNav, settings.open, mode, goMode]);

  /* Escape cierra Ajustes. El "/" y el resto de Escape (menu de una fila,
     detalle de un artista) los maneja cada pantalla con lo suyo. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && settings.open) closeSettings();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [settings.open, closeSettings]);

  /* Adelanto del chunk del modo vecino y de Ajustes cuando la app esta ociosa
     (y no antes, para no competir con la primera pintura). Se repite al cambiar
     de modo: la siguiente pantalla probable cambia. */
  useEffect(() => {
    const preload = () => {
      loadSettingsView();
      MODE_LOADERS[nextGuess(mode)]?.();
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(preload);
      return () => window.cancelIdleCallback?.(id);
    }
    const id = setTimeout(preload, 1500);
    return () => clearTimeout(id);
  }, [mode]);

  /* Saltar a una cancion desde el mini-reproductor. La lista vive en Escuchar:
     si estamos en otro modo (o con Ajustes abierto) primero se cambia de
     pantalla, y ListenView recoge la peticion cuando ya esta a la vista. */
  const revealSong = useCallback(
    (key) => {
      if (settings.open || mode !== "listen") goMode("listen");
      requestReveal(key);
    },
    [settings.open, mode, goMode]
  );

  /* /api/library se pide al montar y no solo al abrir Escuchar: es una lista de
     archivos locales (no toca red) y asi la pantalla ya la tiene al llegar. */
  useEffect(() => {
    loadLib();
  }, [loadLib]);

  /* null = la consulta sigue en vuelo. Sin esta distincion Escuchar mostraria
     "vacia" mientras todavia pregunta. */
  const libFiles = lib || [];
  const libReady = lib !== null;

  const onImportCookies = useCallback(() => openSettings("cookies"), [openSettings]);

  return (
    <main className="app">
      <div className="blob blob--coral" aria-hidden="true" />
      <div className="blob blob--sky" aria-hidden="true" />
      <header className="top">
        <div className="brand">
          <Waveform size={24} weight="bold" className="brand__mark" />
          <span className="brand__name">spitifo</span>
        </div>
        <div className="top__actions">
          <button
            type="button"
            role="switch"
            aria-checked={dark}
            className="themesw"
            onClick={() => chooseTheme(dark ? "light" : "dark")}
            aria-label="Modo oscuro"
            title={
              dark
                ? "Modo oscuro: cambiar a modo claro"
                : "Modo claro: cambiar a modo oscuro"
            }
          >
            <span className="themesw__knob">
              <span className="themesw__ico themesw__ico--moon">
                <Moon size={12} weight="fill" />
              </span>
              <span className="themesw__ico themesw__ico--sun">
                <Sun size={12} weight="fill" />
              </span>
            </span>
          </button>
          <button
            type="button"
            className={cx("top__gear", settings.open && "is-on")}
            onClick={toggleSettings}
            aria-label="Ajustes"
            aria-pressed={settings.open}
            title={settings.open ? "Cerrar los ajustes" : "Abrir los ajustes"}
          >
            <NavIcon name="settings" filled={settings.open} size={19} />
          </button>
        </div>
      </header>

      <Rail
        mode={mode}
        settingsOpen={settings.open}
        onMode={goMode}
        onSettings={toggleSettings}
      />

      <div className="screens" ref={screensRef}>
        {visited.has("download") && (
          <Screen id="download" active={activeId === "download"}>
            <DownloadView
              health={health}
              onLibraryChanged={loadLib}
              onImportCookies={onImportCookies}
            />
          </Screen>
        )}

        {visited.has("listen") && (
          <Screen id="listen" active={activeId === "listen"}>
            <ListenView
              files={libFiles}
              ready={libReady}
              error={libErr}
              errorCode={libErrCode}
              health={health}
              active={activeId === "listen"}
              onOpenStorage={() => openSettings("storage")}
              onRetry={loadLib}
              onGoDownload={() => goMode("download")}
            />
          </Screen>
        )}

        {visited.has("discover") && (
          <Screen id="discover" active={activeId === "discover"}>
            <DiscoverView />
          </Screen>
        )}

        {visited.has("settings") && (
          <Screen id="settings" active={activeId === "settings"}>
            <SettingsView
              active={activeId === "settings"}
              focus={settings.focus}
              onClose={closeSettings}
              onChanged={onStorageChanged}
              phoneNav={phoneNav}
              onPhoneNav={changePhoneNav}
            />
          </Screen>
        )}
      </div>

      <MiniPlayer onReveal={revealSong} />
      {/* Montado una sola vez: es el dueno del <video> y por eso la
          reproduccion no se corta al cambiar de modo. */}
      <VideoHost />

      {phoneNav === "tabs" ? (
        <TabBar mode={mode} onMode={goMode} />
      ) : (
        <SwipeDots mode={mode} onMode={goMode} />
      )}
    </main>
  );
}
