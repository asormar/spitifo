/* ---------------------------------------------------------------------------
   MEDIA SESSION

   Lo que ven las teclas multimedia, los auriculares y la pantalla de bloqueo:
   titulo, portada, estado y acciones. No hay una copia del estado: se suscribe
   al motor y traduce su foto. Progresivo: sin la API no se hace nada, y cada
   accion va en try/catch porque cada navegador soporta un subconjunto distinto
   y las que no conoce lanzan en vez de ignorarse.
   ------------------------------------------------------------------------- */

export function bindMediaSession(engine) {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return () => {};
  }

  const ms = navigator.mediaSession;
  let lastKey;
  let lastNext = null;
  let lastPositionAt = 0;

  const setHandler = (name, handler) => {
    try {
      ms.setActionHandler(name, handler);
    } catch {
      /* accion no soportada */
    }
  };

  /* Las acciones leen la foto vigente del motor al pulsarse, no la del momento
     en que se registraron: si no, "adelantar 10 s" partiria del segundo que
     sonaba al enganchar el handler. */
  setHandler("play", () => engine.resume());
  setHandler("pause", () => engine.pause());
  setHandler("seekto", (d) => {
    if (typeof d?.seekTime === "number") engine.seek(d.seekTime);
  });
  setHandler("seekbackward", (d) => {
    const s = engine.getState();
    engine.seek(s.time - (d?.seekOffset || 10));
  });
  setHandler("seekforward", (d) => {
    const s = engine.getState();
    engine.seek(s.time + (d?.seekOffset || 10));
  });
  setHandler("previoustrack", () => engine.prev());

  const apply = (s) => {
    if (s.track?.key !== lastKey) {
      lastKey = s.track?.key;
      /* La barra de la pantalla de bloqueo tiene que aparecer ya con la pista
         nueva, sin esperar al primer segundo de reproduccion. */
      lastPositionAt = 0;
      try {
        ms.metadata =
          s.track && typeof MediaMetadata !== "undefined"
            ? new MediaMetadata({
                title: s.track.title || "",
                artist: s.track.meta || "",
                /* Solo las filas de resultados traen portada (300x300). */
                artwork: s.track.artwork
                  ? [{ src: s.track.artwork, sizes: "300x300" }]
                  : [],
              })
            : null;
      } catch {
        /* los metadatos son opcionales */
      }
    }

    try {
      ms.playbackState = !s.track ? "none" : s.playing ? "playing" : "paused";
    } catch {
      /* idem */
    }

    /* Sin siguiente en la cola, el handler se anula y el boton desaparece de la
       pantalla de bloqueo en vez de quedarse ahi sin hacer nada. */
    const hasNext = s.index >= 0 && s.index + 1 < s.queue.length;
    if (hasNext !== lastNext) {
      lastNext = hasNext;
      setHandler("nexttrack", hasNext ? () => engine.next() : null);
    }

    const now = Date.now();
    if (
      Number.isFinite(s.duration) &&
      s.duration > 0 &&
      now - lastPositionAt >= 1000
    ) {
      lastPositionAt = now;
      try {
        ms.setPositionState({
          duration: s.duration,
          position: Math.min(s.time, s.duration),
          playbackRate: 1,
        });
      } catch {
        /* posicion no soportada o valores fuera de rango */
      }
    }
  };

  const unsubscribe = engine.subscribe(() => apply(engine.getState()));
  apply(engine.getState());

  return () => {
    unsubscribe();
    [
      "play",
      "pause",
      "seekto",
      "seekbackward",
      "seekforward",
      "previoustrack",
      "nexttrack",
    ].forEach((n) => setHandler(n, null));
    try {
      ms.metadata = null;
    } catch {
      /* idem */
    }
  };
}
