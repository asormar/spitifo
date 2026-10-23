import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../shared/icons.jsx";
import { engine } from "./engine.js";
import { setVideoEl, setVideoHost, useVideoHost, videoHost } from "./videoStore.js";

/* Lo que se puede tabular dentro del dialogo, para atrapar el Tab. */
const VHOST_FOCUSABLE =
  'a[href], button:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

const VHOST_TITLE_ID = "vhost-title";

function VideoHost() {
  const st = useVideoHost();
  const mode = st.mode;
  const item = st.item;
  const vidRef = useRef(null);
  const frameRef = useRef(null);
  const cardRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pip, setPip] = useState(false);
  const [fs, setFs] = useState(false);
  const [notice, setNotice] = useState(null);

  /* En WebView2 ninguna de las dos APIs existe en todas las versiones: los
     botones se esconden cuando no estan, en vez de fallar al pulsarlos. */
  const pipSupported =
    typeof document.pictureInPictureEnabled === "boolean"
    && document.pictureInPictureEnabled;
  const fsSupported = Boolean(document.fullscreenEnabled);

  const inPip = useCallback(
    () =>
      Boolean(document.pictureInPictureElement)
      && document.pictureInPictureElement === vidRef.current,
    []
  );

  /* El elemento se monta una sola vez: aca solo se le enganchan los eventos
     nativos y se expone a pauseVideo. */
  useEffect(() => {
    const v = vidRef.current;
    if (!v) return undefined;
    setVideoEl(v);
    const onPlay = () => {
      /* Un solo medio a la vez: si sonaba una cancion, se para. El motor es el
         dueno de todo el audio; el mini-reproductor se oculta mientras el
         VideoHost esta abierto. */
      engine.pause();
      setFailed(false);
      setPlaying(true);
    };
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    const onError = () => {
      setPlaying(false);
      setFailed(true);
    };
    const onEnterPip = () => setPip(true);
    const onLeavePip = () => {
      setPip(false);
      /* Cerrar la ventana flotante devuelve el video a la app, en el modo en
         que estaba antes de sacarlo. */
      if (videoHost.mode === "closed") {
        setVideoHost({ mode: videoHost.pipReturn || "modal" });
      }
    };
    const onFs = () => setFs(Boolean(document.fullscreenElement));
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);
    v.addEventListener("error", onError);
    v.addEventListener("enterpictureinpicture", onEnterPip);
    v.addEventListener("leavepictureinpicture", onLeavePip);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onEnded);
      v.removeEventListener("error", onError);
      v.removeEventListener("enterpictureinpicture", onEnterPip);
      v.removeEventListener("leavepictureinpicture", onLeavePip);
      document.removeEventListener("fullscreenchange", onFs);
      setVideoEl(null);
    };
  }, []);

  /* El src se escribe a mano y SOLO cuando cambia el archivo. Atado al render,
     cada cambio de modo volveria a pedir el video (y mataria la reproduccion). */
  useEffect(() => {
    const v = vidRef.current;
    if (!v) return;
    const next = item?.src || "";
    if (next === (v.getAttribute("src") || "")) return;
    setFailed(false);
    setNotice(null);
    if (next) v.setAttribute("src", next);
    else {
      /* Cerrar de verdad: se suelta el archivo (y con el, el buffer). */
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
  }, [item?.src]);

  /* Al abrir se intenta arrancar solo: venimos de un clic, asi que el navegador
     lo permite. Si lo bloquea, queda pausado y manda el boton de play. */
  useEffect(() => {
    if (!item) return;
    const v = vidRef.current;
    v?.play().catch(() => {});
  }, [item]);

  /* La ventana centrada bloquea el scroll de la pagina. El minireproductor no:
     la biblioteca tiene que seguir viva por detras. */
  useEffect(() => {
    document.documentElement.classList.toggle("vscroll-lock", mode === "modal");
    return () => document.documentElement.classList.remove("vscroll-lock");
  }, [mode]);

  const close = useCallback(() => {
    /* Con la ventana flotante activa, cerrar la caja de la app no corta el
       video: se sigue viendo en PiP y al salir de el vuelve aca. */
    if (inPip()) {
      setVideoHost({ mode: "closed" });
      return;
    }
    vidRef.current?.pause();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setVideoHost({ mode: "closed", item: null });
  }, [inPip]);

  /* Foco: entra al dialogo al abrir, se queda dentro (Tab) y vuelve a la
     miniatura al cerrar. El primer tabulado es el propio <video>: es lo primero
     que se quiere tocar. */
  useEffect(() => {
    if (mode !== "modal") return undefined;
    const card = cardRef.current;
    if (!card) return undefined;
    const focusables = () =>
      Array.from(card.querySelectorAll(VHOST_FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0
      );
    (focusables()[0] || card).focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        /* El atajo de Escape tambien cierra la biblioteca: se corta aca para
           que haga una sola cosa. */
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (!list.length) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (!card.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [mode, close]);

  /* Devolver el foco se hace despues del cambio (si no, el boton ya esta
     oculto y el foco cae al <body>). */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (mode !== "closed") {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const op = videoHost.opener;
    videoHost.opener = null;
    if (op?.isConnected) op.focus();
  }, [mode]);

  const togglePlay = () => {
    const v = vidRef.current;
    if (!v || failed) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  const toggleFs = async () => {
    const frame = frameRef.current;
    if (!frame || !fsSupported) return;
    setNotice(null);
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await frame.requestFullscreen();
    } catch (e) {
      setNotice("No se pudo poner el vídeo a pantalla completa.");
    }
  };

  const togglePip = async () => {
    const v = vidRef.current;
    if (!v || !pipSupported) return;
    setNotice(null);
    try {
      if (inPip()) await document.exitPictureInPicture();
      else {
        setVideoHost({ pipReturn: mode === "mini" ? "mini" : "modal" });
        await v.requestPictureInPicture();
      }
    } catch (e) {
      setNotice("No se pudo abrir la ventana flotante.");
    }
  };

  const toMini = async () => {
    /* Pantalla completa y minireproductor no pueden convivir: el marco a
       pantalla completa tapa la esquina. */
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch (e) {
        /* sin pantalla completa que salir */
      }
    }
    setVideoHost({ mode: "mini" });
  };

  const toModal = () => setVideoHost({ mode: "modal" });

  const label = item?.title || "Vídeo";
  const sub = [item?.artist, item?.hasAudio === false ? "sin audio" : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="vhost" data-mode={mode} data-no-swipe="">
      <div className="vhost__scrim" aria-hidden="true" onClick={close} />
      <div
        ref={cardRef}
        className="vhost__card"
        data-mode={mode}
        role={mode === "modal" ? "dialog" : "region"}
        aria-modal={mode === "modal" ? "true" : undefined}
        aria-labelledby={mode === "modal" ? VHOST_TITLE_ID : undefined}
        aria-label={mode === "modal" ? undefined : `Minireproductor: ${label}`}
        aria-hidden={mode === "closed" ? true : undefined}
        inert={mode === "closed" ? "" : undefined}
        tabIndex={-1}
      >
        <div ref={frameRef} className="vhost__frame">
          {/* El <video> NO cambia de nodo entre modal y mini: por eso la
              reproduccion no se corta al cambiar de modo. */}
          <video
            ref={vidRef}
            className="vhost__video"
            controls={mode === "modal" ? true : undefined}
            playsInline
            preload="metadata"
          />
          {failed && (
            <p className="vhost__fail" role="alert">
              No se pudo cargar el vídeo.
            </p>
          )}
          {mode === "mini" && (
            <div className="vhost__mini">
              <button
                type="button"
                className="vhb vhb--over"
                onClick={togglePlay}
                aria-label={`${playing ? "Pausar" : "Reproducir"}: ${label}`}
                title={playing ? "Pausar" : "Reproducir"}
              >
                {playing ? <Icon name="Pause" size={16} weight="fill" /> : <Icon name="Play" size={16} weight="fill" />}
              </button>
              <button
                type="button"
                className="vhb vhb--over"
                onClick={toModal}
                aria-label="Ampliar el vídeo"
                title="Ampliar el vídeo"
              >
                <Icon name="CornersOut" size={16} />
              </button>
              <button
                type="button"
                className="vhb vhb--over"
                onClick={close}
                aria-label="Cerrar el vídeo"
                title="Cerrar el vídeo"
              >
                <Icon name="X" size={16} />
              </button>
            </div>
          )}
        </div>

        {mode === "modal" ? (
          <div className="vhost__foot">
            <div className="vhost__titles">
              <h2 className="vhost__title" id={VHOST_TITLE_ID}>
                {label}
              </h2>
              {sub && <p className="vhost__sub">{sub}</p>}
            </div>
            <div className="vhost__tools">
              {fsSupported && (
                <button
                  type="button"
                  className="vhb"
                  onClick={toggleFs}
                  aria-label={fs ? "Salir de pantalla completa" : "Pantalla completa"}
                >
                  {fs ? <Icon name="ArrowsIn" size={16} /> : <Icon name="ArrowsOut" size={16} />}
                  <span className="vhost__lbl">{fs ? "Salir" : "Pantalla completa"}</span>
                </button>
              )}
              {pipSupported && (
                <button
                  type="button"
                  className="vhb"
                  onClick={togglePip}
                  aria-label="Otra ventana"
                  title={pip ? "Volver a traer la ventana flotante" : "Ver en una ventana flotante"}
                >
                  <Icon name="PictureInPicture" size={16} />
                  <span className="vhost__lbl">Otra ventana</span>
                </button>
              )}
              <button
                type="button"
                className="vhb"
                onClick={toMini}
                aria-label="Minireproductor"
                title="Ver en el minireproductor"
              >
                <Icon name="CornersIn" size={16} />
                <span className="vhost__lbl">Minireproductor</span>
              </button>
              <button type="button" className="vhb" onClick={close} aria-label="Cerrar el vídeo">
                <Icon name="X" size={16} />
                <span className="vhost__lbl">Cerrar</span>
              </button>
            </div>
          </div>
        ) : (
          <p className="vhost__mini-title" title={label}>
            {label}
          </p>
        )}

        {notice && (
          <p className="vhost__notice" role="alert">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}

export default VideoHost;
