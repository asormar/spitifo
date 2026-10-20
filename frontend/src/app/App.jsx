import React, { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Moon, Stack, Sun, Waveform, X } from "@phosphor-icons/react";
import { API } from "../shared/api.js";
import { useTheme } from "../shared/theme.js";
import MiniPlayer from "../player/MiniPlayer.jsx";
import VideoHost from "../player/VideoHost.jsx";

const loadDownloadView = () => import("../download/DownloadView.jsx");
const DownloadView = React.lazy(loadDownloadView);
/* Arranca la descarga del chunk ya: llega en paralelo con el primer render. */
loadDownloadView();
/* La biblioteca y la configuracion se cargan a demanda, pero el componente se
   guarda aqui en cuanto llega su chunk: si ya esta (lo normal, se adelanta con
   la app ociosa), abrirlas es sincrono dentro del propio evento, igual que
   cuando todo vivia en un solo archivo. Solo se espera si aun no llego. */
let LibraryComponent = null;
let StorageComponent = null;
const loadLibrary = () =>
  import("../player/Library.jsx").then((m) => (LibraryComponent = m.default));
const loadStorageDialog = () =>
  import("../settings/StorageDialog.jsx").then((m) => (StorageComponent = m.default));

export default function App() {
  const [health, setHealth] = useState(null);
  /* null = todavia no lo sabemos. Distinguir "vacia" de "sin consultar" importa:
     sin esto el boton arrancaria atenuado y el contador no apareceria hasta
     abrir el panel, que es justo cuando ya no hace falta. */
  const [lib, setLib] = useState(null);
  const [libOpen, setLibOpen] = useState(false);
  const drawerRef = useRef(null);
  const libBtnRef = useRef(null);
  /* true = /api/library fallo y todavia no hay lista que mostrar. */
  const [libErr, setLibErr] = useState(false);
  /* Codigo del ultimo fallo: `reconnect_required` tiene su propia salida. */
  const [libErrCode, setLibErrCode] = useState(null);
  const [storageOpen, setStorageOpen] = useState(false);
  /* Abre la configuracion con la seccion de cookies de YouTube a la vista. */
  const [cookiesHint, setCookiesHint] = useState(false);
  /* Componentes cargados a demanda. La biblioteca y la configuracion NO usan
     React.lazy: se guarda el componente ya resuelto para poder montarlo en el
     mismo commit en que se abre (una primera suspension romperia la transicion
     del cajon / el showModal del dialogo). */
  const [LibraryView, setLibraryView] = useState(null);
  const [StorageView, setStorageView] = useState(null);

  const [theme, chooseTheme] = useTheme();
  const dark = theme === "dark";

  const loadHealth = useCallback(() => {
    fetch(`${API}/health`)
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);
  useEffect(loadHealth, [loadHealth]);

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

  /* Abre la biblioteca. Con el chunk ya cargado, en el mismo evento; si no,
     cuando llegue. `then` recibe la funcion para que la llamada siga siendo
     sincrona en el caso normal. */
  const openLibrary = useCallback((then) => {
    const show = (C) => {
      setLibraryView(() => C);
      setLibOpen(true);
      then?.();
    };
    if (LibraryComponent) show(LibraryComponent);
    else loadLibrary().then(show);
  }, []);

  const toggleLib = useCallback(() => {
    if (libOpen) {
      setLibOpen(false);
      return;
    }
    openLibrary();
  }, [libOpen, openLibrary]);

  /* El cajon se monta la primera vez que se abre y ya no se desmonta: sus
     Player siguen vivos al cerrarlo y la musica no se corta. Abrir/cerrar es
     solo `data-state` + una transicion CSS (interrumpible, a diferencia de un
     keyframe).
     - libEver: ya se abrio alguna vez (monta el cajon).
     - libShow: el estado visual. Va un fotograma por detras de libOpen al abrir
       para que el cajon se pinte primero cerrado y la transicion tenga desde
       donde arrancar; al cerrar va a la par.
     - libSettled: la apertura termino. Hasta entonces recorta su contenido,
       despues lo libera para que la sombra del panel no quede cortada. */
  const [libEver, setLibEver] = useState(false);
  const [libShow, setLibShow] = useState(false);
  const [libSettled, setLibSettled] = useState(false);
  /* Layout effect y no requestAnimationFrame: con la pestana en segundo plano
     rAF no se dispara y el cajon se quedaba cerrado para siempre. */
  useLayoutEffect(() => {
    if (!libOpen) {
      setLibShow(false);
      setLibSettled(false);
      return;
    }
    if (!libEver) {
      setLibEver(true);
      return;
    }
    /* Leer una medida fuerza el calculo de estilo del estado cerrado antes de
       pasar a abierto; sin esto el navegador fusiona los dos y no anima. */
    void drawerRef.current?.offsetHeight;
    setLibShow(true);
  }, [libOpen, libEver]);

  /* Saltar a una cancion desde el mini-reproductor. Si vive en la biblioteca
     cerrada hay que abrirla y esperar a que el cajon termine de crecer, o el
     scroll apunta a una posicion que aun no existe. */
  const revealSong = useCallback(
    (el) => {
      if (!el) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const go = () =>
        el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      if (el.closest(".drawer") && !libOpen) {
        openLibrary(() => setTimeout(go, 320));
      } else {
        go();
      }
    },
    [libOpen, openLibrary]
  );

  /* El contador del boton tiene que ser real desde el primer render, asi que
     /api/library se pide al montar y no solo al abrir el panel. Es una lista
     de archivos locales: no toca red. */
  useEffect(() => {
    loadLib();
  }, [loadLib]);

  /* null = la consulta sigue en vuelo. Sin esta distincion el boton
     arrancaria atenuado como si la biblioteca estuviera vacia. */
  const libFiles = lib || [];
  const libReady = lib !== null;
  const libCount = libFiles.length;

  const libTitle = libOpen
    ? "Ocultar la biblioteca"
    : libCount > 0
      ? `Abrir la biblioteca (${libCount} ${libCount === 1 ? "tema" : "temas"})`
      : "Biblioteca vacía: todavía no has descargado nada";
  const libAria = libOpen
    ? "Cerrar la biblioteca"
    : libCount > 0
      ? `Biblioteca, ${libCount} ${libCount === 1 ? "tema" : "temas"}`
      : "Biblioteca, vacía";

  /* Monta el dialogo la primera vez que se abre (y lo deja montado). */
  const openStorage = useCallback((hint = false) => {
    const show = (C) => {
      setStorageView(() => C);
      setCookiesHint(hint);
      setStorageOpen(true);
    };
    if (StorageComponent) show(StorageComponent);
    else loadStorageDialog().then(show);
  }, []);

  const closeStorage = useCallback(() => {
    setStorageOpen(false);
    setCookiesHint(false);
  }, []);

  const onImportCookies = useCallback(() => openStorage(true), [openStorage]);

  /* Escape cierra la biblioteca; el "/" lo maneja DownloadView. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && libOpen) {
        /* El foco se mueve ANTES de cerrar: el cajon cerrado es `inert` y, con
           el foco dentro, se perderia en el <body>. */
        if (drawerRef.current?.contains(document.activeElement)) libBtnRef.current?.focus();
        setLibOpen(false);
        return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [libOpen]);

  /* Los chunks de la biblioteca y la configuracion se adelantan cuando la app
     esta ociosa (y no antes, para no competir con la primera pintura). */
  useEffect(() => {
    const preload = () => {
      loadLibrary();
      loadStorageDialog();
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(preload);
      return () => window.cancelIdleCallback?.(id);
    }
    const id = setTimeout(preload, 1500);
    return () => clearTimeout(id);
  }, []);

  const librarySlot = libEver ? (
    <div
      ref={drawerRef}
      className="drawer"
      data-state={libShow ? "open" : "closed"}
      data-settled={libSettled && libShow ? "" : undefined}
      aria-hidden={libShow ? undefined : true}
      inert={libShow ? undefined : ""}
      onTransitionEnd={(e) => {
        if (
          e.target === e.currentTarget &&
          e.propertyName === "grid-template-rows" &&
          libShow
        ) {
          setLibSettled(true);
        }
      }}
    >
      {LibraryView && (
        <LibraryView
          libFiles={libFiles}
          libReady={libReady}
          libCount={libCount}
          libErr={libErr}
          libErrCode={libErrCode}
          health={health}
          onOpenStorage={() => openStorage(false)}
          onRetry={loadLib}
        />
      )}
    </div>
  ) : null;

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
          ref={libBtnRef}
          className={[
            "libbtn",
            libOpen ? "is-on" : "",
            libReady && libCount === 0 ? "is-empty" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={toggleLib}
          onPointerEnter={loadLibrary}
          onFocus={loadLibrary}
          aria-expanded={libOpen}
          aria-label={libAria}
          title={libTitle}
        >
          <span className="swap" key={libOpen ? "x" : "stack"}>
            {libOpen ? <X size={17} /> : <Stack size={17} />}
          </span>
          <span className="libbtn__lbl">{libOpen ? "Cerrar" : "Biblioteca"}</span>
          {!libOpen && libCount > 0 && (
            <span className="count count--bump" key={libCount}>
              {libCount}
            </span>
          )}
        </button>
        </div>
      </header>

      <Suspense fallback={null}>
        <DownloadView
          health={health}
          onLibraryChanged={loadLib}
          onImportCookies={onImportCookies}
          librarySlot={librarySlot}
        />
      </Suspense>

      <MiniPlayer libOpen={libOpen} onReveal={revealSong} />
      {/* Montado una sola vez: es el dueno del <video> y por eso la
          reproduccion no se corta al cambiar de modo. */}
      <VideoHost />
      {StorageView && (
        <StorageView
          open={storageOpen}
          onClose={closeStorage}
          onChanged={onStorageChanged}
          focusCookies={cookiesHint}
        />
      )}
    </main>
  );
}
