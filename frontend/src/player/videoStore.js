import { useEffect, useReducer } from "react";

/* ---------------------------------------------------------------------------
   VIDEOHOST

   Un video no cabe en el <Player> de audio: su <audio> no pinta imagen y su
   interfaz habla de canciones. VideoHost es su superficie, y es UNA sola: vive
   montado en la raiz de App y es dueno de un unico <video> que NUNCA se
   desmonta. Pasar de ventana centrada (modal) a minireproductor (mini) es
   cambiar la clase de la caja que lo contiene; el archivo no se vuelve a pedir
   y la reproduccion sigue en el mismo segundo.

   El estado vive en un almacen de modulo, como `current`/`watchers` del
   reproductor de audio: cualquier fila de la biblioteca puede pedir
   openVideo(...) sin arrastrar callbacks por medio arbol.

   Estados: closed | modal | mini
   ------------------------------------------------------------------------- */

export const videoHost = {
  mode: "closed",
  item: null,
  /* Boton (la miniatura) que lo abrio: ahi vuelve el foco al cerrar. */
  opener: null,
  /* A que modo vuelve el video cuando se cierra la ventana flotante: al entrar
     en PiP se recuerda el que estaba. */
  pipReturn: "modal",
};

const videoWatchers = new Set();

export function setVideoHost(patch) {
  Object.assign(videoHost, patch);
  videoWatchers.forEach((w) => w());
}

export function useVideoHost() {
  const [, repaint] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    videoWatchers.add(repaint);
    return () => videoWatchers.delete(repaint);
  }, []);
  return videoHost;
}

/* El <video> de verdad. El Player de audio lo pausa en cuanto empieza a sonar
   algo: una sola cosa suena a la vez, y eso incluye al video. */
let videoEl = null;

/* VideoHost es el dueno de `videoEl`: lo fija al montar y lo suelta al
   desmontar. Se expone por setter para no reasignar un binding importado. */
export function setVideoEl(el) {
  videoEl = el;
}

export function pauseVideo() {
  if (videoEl && !videoEl.paused) videoEl.pause();
}

export function openVideo(item, opener) {
  setVideoHost({ item, opener: opener || null, mode: "modal" });
}
