import { useEffect, useRef, useState } from "react";
import { engine } from "./engine.js";
import { useEngine } from "./useEngine.js";
import { useVideoHost } from "./videoStore.js";
import { dockVisible } from "./dock.js";

/* ---------------------------------------------------------------------------
   REPRODUCTOR FLOTANTE (lo comun)

   La pastilla del telefono (MiniPlayer) y la barra del escritorio (PlayerBar)
   son dos vistas del mismo motor. Aqui va lo que no se pinta: cuando se ven, la
   pista que muestran, el icono de play y la X. No hay audio propio ni
   IntersectionObserver: con una pista cargada se ve siempre, salvo con "Ahora
   suena" o el video abiertos (ver dock.js). Si el usuario la cierra con la X,
   pausa y se queda cerrada hasta la siguiente pista o el siguiente play.

   Los selectores devuelven primitivos: el tiempo no se lee aqui (lo pinta
   Scrub), asi la pastilla no se repinta cuatro veces por segundo.
   ------------------------------------------------------------------------- */

export default function useDock(npOpen) {
  const track = useEngine((s) => s.track);
  const playing = useEngine((s) => s.playing);
  const buffering = useEngine((s) => s.buffering);
  const duration = useEngine((s) => s.duration);
  const hasNext = useEngine((s) => s.index >= 0 && s.index + 1 < s.queue.length);
  const vhost = useVideoHost();
  const [dismissed, setDismissed] = useState(false);
  /* Portada que ya fallo al cargar: no se vuelve a pintar (icono roto). */
  const [badArt, setBadArt] = useState(null);
  const lastInfo = useRef(null);

  /* El motor no suelta la pista al terminar la cola, pero se guarda la ultima
     igual: si algun dia lo hace, el texto no se vacia mientras la pastilla se
     desvanece. */
  if (track) lastInfo.current = track;
  const info = track || lastInfo.current;

  /* Otro destino = otra cancion: se vuelve a ofrecer. */
  useEffect(() => {
    setDismissed(false);
  }, [track?.key]);

  /* Y reproducir tambien la reabre (reanudar desde la fila). */
  useEffect(() => {
    if (playing) setDismissed(false);
  }, [playing]);

  const show = dockVisible({ track, npOpen, vhostMode: vhost.mode, dismissed });

  /* "Artista · Album", como lo arma la biblioteca. */
  const meta = info?.meta ?? "";
  const at = meta.indexOf(" · ");

  /* Reserva sitio en la pagina y aparta los avisos (CSS: body.has-mini). */
  useEffect(() => {
    document.body.classList.toggle("has-mini", show);
    return () => document.body.classList.remove("has-mini");
  }, [show]);

  return {
    show,
    info,
    meta,
    artist: at < 0 ? meta : meta.slice(0, at),
    album: at < 0 ? "" : meta.slice(at + 3),
    playing,
    icon: buffering ? "load" : playing ? "pause" : "play",
    label: info?.label || "la canción",
    hasNext,
    dur: duration || info?.duration || 0,
    art: info?.artwork && badArt !== info.artwork ? info.artwork : null,
    onArtError: () => setBadArt(info?.artwork ?? null),
    close: () => {
      engine.pause();
      setDismissed(true);
    },
  };
}
